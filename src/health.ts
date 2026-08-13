import * as net from "node:net";
import type { Healthcheck, Project, Service } from "./config.js";
import { serviceEnv } from "./config.js";
import { commandExists, run, shQuote } from "./proc.js";
import { composeExec, composePs } from "./docker.js";

function tcpProbe(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, host);
  });
}

async function httpProbe(hc: Healthcheck): Promise<boolean> {
  if (!hc.url) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(hc.url, { signal: ctrl.signal, redirect: "follow" });
    if (hc.expectStatus !== undefined) return res.status === hc.expectStatus;
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function postgresProbe(svc: Service, hc: Healthcheck): Promise<boolean> {
  const host = hc.host;
  const port = hc.port ?? 5432;
  if (commandExists("pg_isready")) {
    const r = await run(`pg_isready -h ${shQuote(host)} -p ${port} -t 2 -q`, { timeoutMs: 4000 });
    return r.code === 0;
  }
  if (svc.type === "docker" && svc.composeService) {
    const r = await composeExec(svc, "pg_isready -q -t 2");
    if (r.code === 0) return true;
    if (r.code === 1 || r.code === 2) return false; // reachable but not ready
  }
  return tcpProbe(host, port);
}

async function redisProbe(svc: Service, hc: Healthcheck): Promise<boolean> {
  const host = hc.host;
  const port = hc.port ?? 6379;
  if (commandExists("redis-cli")) {
    const r = await run(`redis-cli -h ${shQuote(host)} -p ${port} ping`, { timeoutMs: 4000 });
    return r.code === 0 && r.stdout.trim().toUpperCase() === "PONG";
  }
  if (svc.type === "docker" && svc.composeService) {
    const r = await composeExec(svc, "redis-cli ping");
    if (r.stdout.trim().toUpperCase() === "PONG") return true;
    if (r.code === 0) return false;
  }
  return tcpProbe(host, port);
}

async function dockerProbe(svc: Service): Promise<boolean> {
  const info = await composePs(svc);
  if (!info) return false;
  if (info.state !== "running") return false;
  if (info.health) return info.health === "healthy";
  return true;
}

async function commandProbe(svc: Service, hc: Healthcheck, project: Project): Promise<boolean> {
  if (!hc.command) return false;
  const r = await run(hc.command, { cwd: svc.cwd, env: serviceEnv(project, svc), timeoutMs: 6000 });
  return r.code === 0;
}

/** One health probe attempt. */
export async function probe(svc: Service, project: Project): Promise<boolean> {
  const hc = svc.healthcheck;
  if (!hc) return true;
  switch (hc.type) {
    case "tcp":
      return tcpProbe(hc.host, hc.port ?? 0);
    case "http":
      return httpProbe(hc);
    case "postgres":
      return postgresProbe(svc, hc);
    case "redis":
      return redisProbe(svc, hc);
    case "docker":
      return dockerProbe(svc);
    case "command":
      return commandProbe(svc, hc, project);
  }
}

export function healthLabel(hc: Healthcheck): string {
  switch (hc.type) {
    case "tcp":
      return `tcp :${hc.port}`;
    case "http":
      return `http ${hc.url}`;
    case "postgres":
      return `postgres :${hc.port}`;
    case "redis":
      return `redis :${hc.port}`;
    case "docker":
      return "docker health";
    case "command":
      return "command";
  }
}

export interface WaitResult {
  ok: boolean;
  elapsedMs: number;
}

/**
 * Poll until healthy or timeout. `stillAlive` lets the caller abort early when
 * the underlying process has already died (no point waiting out the timeout).
 */
export async function waitHealthy(
  svc: Service,
  project: Project,
  stillAlive?: () => boolean,
): Promise<WaitResult> {
  const hc = svc.healthcheck;
  const start = Date.now();
  if (!hc) return { ok: true, elapsedMs: 0 };
  const deadline = start + hc.timeoutSec * 1000;
  const interval = Math.max(200, hc.intervalSec * 1000);
  for (;;) {
    if (await probe(svc, project)) return { ok: true, elapsedMs: Date.now() - start };
    if (stillAlive && !stillAlive()) return { ok: false, elapsedMs: Date.now() - start };
    if (Date.now() + interval > deadline) return { ok: false, elapsedMs: Date.now() - start };
    await new Promise((r) => setTimeout(r, interval));
  }
}
