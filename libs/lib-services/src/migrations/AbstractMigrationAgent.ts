import { LockManager } from '../locks/LockManager.js';
import { logger } from '../logger/Logger.js';
import * as defs from './migration-definitions.js';

export type MigrationParams<Generics extends MigrationAgentGenerics = MigrationAgentGenerics> = {
  count?: number;
  direction: defs.Direction;
  migrationContext?: Generics['MIGRATION_CONTEXT'];
};

type WriteLogsParams = {
  state?: defs.MigrationState;
  log_stream: Iterable<defs.ExecutedMigration> | AsyncIterable<defs.ExecutedMigration>;
};

export type MigrationAgentGenerics = {
  MIGRATION_CONTEXT?: {};
};

export type RunMigrationParams<Generics extends MigrationAgentGenerics = MigrationAgentGenerics> = MigrationParams & {
  migrations: defs.Migration<Generics['MIGRATION_CONTEXT']>[];
  maxLockWaitMs?: number;
};

type ExecuteParams = RunMigrationParams & {
  state?: defs.MigrationState;
};

export const DEFAULT_MAX_LOCK_WAIT_MS = 3 * 60 * 1000; // 3 minutes

export abstract class AbstractMigrationAgent<Generics extends MigrationAgentGenerics = MigrationAgentGenerics>
  implements AsyncDisposable
{
  abstract get store(): defs.MigrationStore;
  abstract get locks(): LockManager;

  abstract loadInternalMigrations(): Promise<defs.Migration<Generics['MIGRATION_CONTEXT']>[]>;

  abstract [Symbol.asyncDispose](): Promise<void>;

  protected async init() {
    await this.locks.init?.();
    await this.store.init?.();
  }

  async run(params: RunMigrationParams) {
    await this.init();

    const { direction, migrations, migrationContext } = params;
    // Only one process should execute this at a time.
    logger.info('Acquiring lock for migrations');
    const lockHandle = await this.locks.acquire({ max_wait_ms: params.maxLockWaitMs ?? DEFAULT_MAX_LOCK_WAIT_MS });

    if (!lockHandle) {
      throw new Error('Could not acquire lock');
    }

    let isReleased = false;
    const releaseLock = async () => {
      if (isReleased) {
        return;
      }
      await lockHandle.release();
      isReleased = true;
    };

    // For the case where the migration is terminated
    process.addListener('beforeExit', releaseLock);

    try {
      const state = await this.store.load();

      logger.info(`Running migrations ${direction}`);
      const logStream = this.execute({
        direction,
        migrations,
        state,
        migrationContext
      });

      await this.writeLogsToStore({
        log_stream: logStream,
        state
      });
    } finally {
      logger.info('Releasing migration lock');
      await releaseLock();
      process.removeListener('beforeExit', releaseLock);
      logger.info('Done with migrations');
    }
  }

  protected async *execute(params: ExecuteParams): AsyncGenerator<defs.ExecutedMigration> {
    const internalMigrations = await this.loadInternalMigrations();
    let migrations = [...internalMigrations, ...params.migrations];

    if (params.direction === defs.Direction.Down) {
      migrations.reverse();
    }

    let index = 0;

    if (params.state) {
      // Find the index of the last run
      const { last_run, log } = params.state;
      index = migrations.findIndex((migration) => {
        return migration.name === params.state!.last_run;
      });

      if (index === -1) {
        throw new Error(
          `The last run migration ${params.state?.last_run} was not found in the given set of migrations`
        );
      }

      // Get the last log entry for the last run migration
      // This should technically be the last (sorted ascending) log entry.
      // Sorting in descending order
      const lastLogEntry = log
        .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
        .find((log) => log.name == last_run);

      // There should be a log entry for this
      if (!lastLogEntry) {
        throw new Error(`Could not find last migration log entry for ${last_run}`);
      }

      // If we are migrating up:
      //  If the last run was an up migration:
      //    Then we want to start at the next migration index
      //  If after a previous Down migration
      //    Then we need to start at the current migration index

      // If we are migrating down:
      //   If the previous migration was a down migration
      //     Then we need to start at the next index
      //   If the previous migration was an up migration
      //      Then we want to include the last run (up) migration
      if (
        (params.direction === defs.Direction.Up && lastLogEntry.direction == defs.Direction.Up) ||
        (params.direction == defs.Direction.Down && lastLogEntry.direction == defs.Direction.Down)
      ) {
        index += 1;
      }
    } else if (params.direction == defs.Direction.Down) {
      // Down migration with no state - exclude all migrations
      index = migrations.length;
    }

    migrations = migrations.slice(index);

    let i = 0;
    const { migrationContext } = params;
    for (const migration of migrations) {
      if (params.count && params.count === i) {
        return;
      }

      logger.info(`Executing ${migration.name} (${params.direction})`);
      try {
        switch (params.direction) {
          case defs.Direction.Up: {
            await migration.up(migrationContext);
            break;
          }
          case defs.Direction.Down: {
            await migration.down(migrationContext);
            break;
          }
        }
        logger.debug(`Success`);
      } catch (err) {
        logger.error(`Failed`, err);
        process.exit(1);
      }

      yield {
        name: migration.name,
        direction: params.direction,
        timestamp: new Date()
      };

      i++;
    }
  }

  resetStore() {
    return this.store.clear();
  }

  protected writeLogsToStore = async (params: WriteLogsParams): Promise<void> => {
    const log = [...(params.state?.log || [])];
    for await (const migration of params.log_stream) {
      log.push(migration);
      await this.store.save({
        last_run: migration.name,
        log: log
      });
    }
  };
}
