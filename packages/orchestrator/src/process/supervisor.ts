/**
 * Process supervisor — manages child processes for agent workers.
 * In production, this delegates to supervisord. For development, it manages
 * processes directly with auto-restart on crash.
 */

import { ChildProcess, spawn } from 'node:child_process';
import { createLogger } from '../logger.js';

const logger = createLogger('supervisor');

export interface ProcessConfig {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  autoRestart: boolean;
  maxRestarts: number;
  restartDelay: number;
}

interface ManagedProcess {
  config: ProcessConfig;
  process?: ChildProcess;
  restarts: number;
  status: 'stopped' | 'running' | 'crashed' | 'restarting';
  startedAt?: Date;
}

export class ProcessSupervisor {
  private processes: Map<string, ManagedProcess> = new Map();
  private shutdownRequested = false;

  /**
   * Register a process to be managed.
   */
  register(config: ProcessConfig): void {
    this.processes.set(config.name, {
      config,
      restarts: 0,
      status: 'stopped',
    });
    logger.info({ name: config.name, command: config.command }, 'Process registered');
  }

  /**
   * Start a managed process.
   */
  start(name: string): boolean {
    const managed = this.processes.get(name);
    if (!managed) {
      logger.error({ name }, 'Process not registered');
      return false;
    }

    if (managed.status === 'running') {
      logger.warn({ name }, 'Process already running');
      return true;
    }

    return this.spawnProcess(managed);
  }

  /**
   * Start all registered processes.
   */
  startAll(): void {
    for (const name of this.processes.keys()) {
      this.start(name);
    }
  }

  /**
   * Stop a managed process.
   */
  stop(name: string): boolean {
    const managed = this.processes.get(name);
    if (!managed || !managed.process) {
      return false;
    }

    managed.process.kill('SIGTERM');
    managed.status = 'stopped';
    logger.info({ name }, 'Process stopped');
    return true;
  }

  /**
   * Stop all processes gracefully.
   */
  async stopAll(): Promise<void> {
    this.shutdownRequested = true;
    const promises: Promise<void>[] = [];

    for (const [name, managed] of this.processes) {
      if (managed.process && managed.status === 'running') {
        promises.push(
          new Promise<void>((resolve) => {
            managed.process!.once('exit', () => resolve());
            managed.process!.kill('SIGTERM');

            // Force kill after 5 seconds
            setTimeout(() => {
              if (managed.process && !managed.process.killed) {
                managed.process.kill('SIGKILL');
              }
              resolve();
            }, 5000);
          }),
        );
        managed.status = 'stopped';
        logger.info({ name }, 'Stopping process');
      }
    }

    await Promise.all(promises);
    logger.info('All processes stopped');
  }

  /**
   * Get status of all managed processes.
   */
  getStatus(): Record<string, { status: string; restarts: number; pid?: number }> {
    const result: Record<string, { status: string; restarts: number; pid?: number }> = {};
    for (const [name, managed] of this.processes) {
      result[name] = {
        status: managed.status,
        restarts: managed.restarts,
        pid: managed.process?.pid,
      };
    }
    return result;
  }

  private spawnProcess(managed: ManagedProcess): boolean {
    const { config } = managed;

    try {
      const proc = spawn(config.command, config.args, {
        cwd: config.cwd,
        env: { ...process.env, ...config.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      managed.process = proc;
      managed.status = 'running';
      managed.startedAt = new Date();

      proc.stdout?.on('data', (data: Buffer) => {
        logger.debug({ name: config.name, output: data.toString().trim() }, 'stdout');
      });

      proc.stderr?.on('data', (data: Buffer) => {
        logger.warn({ name: config.name, output: data.toString().trim() }, 'stderr');
      });

      proc.on('exit', (code, signal) => {
        logger.info({ name: config.name, code, signal }, 'Process exited');

        if (this.shutdownRequested) {
          managed.status = 'stopped';
          return;
        }

        managed.status = 'crashed';

        // Auto-restart if configured and under the limit
        if (config.autoRestart && managed.restarts < config.maxRestarts) {
          managed.restarts += 1;
          managed.status = 'restarting';
          logger.info({ name: config.name, restarts: managed.restarts }, 'Auto-restarting process');

          setTimeout(() => {
            if (!this.shutdownRequested) {
              this.spawnProcess(managed);
            }
          }, config.restartDelay);
        } else if (managed.restarts >= config.maxRestarts) {
          logger.error({ name: config.name, restarts: managed.restarts }, 'Max restarts exceeded');
        }
      });

      logger.info({ name: config.name, pid: proc.pid }, 'Process started');
      return true;
    } catch (err) {
      logger.error({ err, name: config.name }, 'Failed to spawn process');
      managed.status = 'crashed';
      return false;
    }
  }
}
