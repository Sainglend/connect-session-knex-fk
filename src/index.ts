import knexConstructor, { Knex } from "knex";
import { SessionData, Store } from "express-session";
import {
  dateAsISO,
  getMssqlFastQuery,
  getPostgresFastQuery,
  getMysqlFastQuery,
  getSqliteFastQuery,
  isMSSQL,
  isPostgres,
  isMySQL,
  isOracle,
  isSqlite3,
  timestampTypeName,
  expiredCondition,
  isDbSupportJSON,
} from "./utils";

interface Options {
  cleanupInterval: number; // 0 disables
  createTable: boolean;
  knex: Knex;
  onDbCleanupError: (err: unknown) => void;
  tableName: string;
  sidFieldName: string;
  verbose: boolean;
}

export class ConnectSessionKnexStore extends Store {
  options: Options;
  nextDbCleanup: NodeJS.Timeout | undefined;
  ready: Promise<unknown>; // Schema created

  constructor(incomingOptions: Partial<Options>) {
    super();

    const options = (this.options = {
      cleanupInterval: 60000,
      createTable: true,
      sidFieldName: "sid",
      tableName: "sessions",
      onDbCleanupError: (err: unknown) => {
        console.error(err);
      },
      verbose: false,
      ...incomingOptions,
      knex:
        incomingOptions.knex ??
        knexConstructor({
          client: "sqlite3",
          connection: {
            filename: "connect-session-knex.sqlite",
          },
        }),
    });

    const { cleanupInterval, createTable, knex, sidFieldName, tableName } =
      options;

    this.ready = (async () => {
      if (!(await knex.schema.hasTable(tableName))) {
        if (!createTable) {
          throw new Error(`Missing ${tableName} table`);
        }
        const supportsJson = await isDbSupportJSON(knex);

        await knex.schema.createTable(tableName, (table) => {
          table.string(sidFieldName).primary();
          if (supportsJson) {
            table.json("sess").notNullable();
          } else {
            table.text("sess").notNullable();
          }
          if (isMySQL(knex) || isMSSQL(knex)) {
            table.dateTime("expired").notNullable().index();
          } else {
            table.timestamp("expired").notNullable().index();
          }
        });
      }

      if (cleanupInterval > 0) {
        this.dbCleanup();
      }
    })();
  }

  async get(
    sid: string,
    callback: (err: any, session?: SessionData | null) => void,
  ) {
    try {
      await this.ready;
      const { knex, tableName, sidFieldName, verbose } = this.options;
      const condition = expiredCondition(knex);

      if (verbose) {
        console.log("session get", knex
        .select("sess")
        .from(tableName)
        .where(sidFieldName, "=", sid)
        .andWhereRaw(condition, dateAsISO(knex)).toSQL());
      }

      const response = await knex
        .select("sess")
        .from(tableName)
        .where(sidFieldName, "=", sid)
        .andWhereRaw(condition, dateAsISO(knex));

      let session: SessionData | null = null;
      if (response[0]) {
        session = response[0].sess;
        if (typeof session === "string") {
          session = JSON.parse(session);
        }
      }
      callback?.(null, session);
      return session;
    } catch (err) {
      callback?.(err);
      throw err;
    }
  }

  async set(sid: string, session: SessionData, callback?: (err?: any) => void) {
    try {
      await this.ready;
      const { knex, tableName, sidFieldName, verbose } = this.options;
      const { maxAge } = session.cookie;
      const now = new Date().getTime();
      const expired = maxAge ? now + maxAge : now + 86400000; // 86400000 = add one day
      const sess = JSON.stringify(session);

      const dbDate = dateAsISO(knex, expired);

      if (isSqlite3(knex)) {
        // sqlite optimized query
        await knex.raw(getSqliteFastQuery(tableName, sidFieldName), [
          sid,
          dbDate,
          sess,
        ]);
      } else if (isPostgres(knex) && parseFloat(knex.client.version) >= 9.2) {
        // postgresql optimized query
        if (verbose) {
          console.log("session set", knex.raw(getPostgresFastQuery(tableName, sidFieldName), [
            sid,
            dbDate,
            sess,
          ]).toSQL());
        }
        await knex.raw(getPostgresFastQuery(tableName, sidFieldName), [
          sid,
          dbDate,
          sess,
        ]);
      } else if (isMySQL(knex)) {
        await knex.raw(getMysqlFastQuery(tableName, sidFieldName), [
          sid,
          dbDate,
          sess,
        ]);
      } else if (isMSSQL(knex)) {
        await knex.raw(getMssqlFastQuery(tableName, sidFieldName), [
          sid,
          dbDate,
          sess,
        ]);
      } else {
        await knex.transaction(async (trx) => {
          const foundKeys = await trx
            .select("*")
            .forUpdate()
            .from(tableName)
            .where(sidFieldName, "=", sid);

          if (foundKeys.length === 0) {
            await trx.from(tableName).insert({
              [sidFieldName]: sid,
              expired: dbDate,
              sess,
            });
          } else {
            await trx(tableName).where(sidFieldName, "=", sid).update({
              expired: dbDate,
              sess,
            });
          }
        });
      }

      callback?.();
    } catch (err) {
      callback?.(err);
      throw err;
    }
  }

  async touch(sid: string, session: SessionData, callback?: () => void) {
    await this.ready;
    const { knex, tableName, sidFieldName, verbose } = this.options;

    if (session && session.cookie && session.cookie.expires) {
      if (Date.now() <= session.cookie.expires.getTime()) {
        if (verbose) {
          console.log("session touch", knex(tableName)
            .where(sidFieldName, "=", sid)
            .update({
              expired: dateAsISO(knex, session.cookie.expires),
            }).toSQL());
        }
        await knex(tableName)
          .where(sidFieldName, "=", sid)
          .update({
            expired: dateAsISO(knex, session.cookie.expires),
          });
      }
    }
    callback?.();
  }

  async destroy(sid: string, callback?: (err?: any) => void) {
    try {
      await this.ready;
      const { knex, tableName, sidFieldName, verbose } = this.options;

      if (verbose) {
        console.log("destroy session", knex
          .del()
          .from(tableName)
          .where(sidFieldName, "=", sid).toSQL());
      }
      const retVal = await knex
        .del()
        .from(tableName)
        .where(sidFieldName, "=", sid);
      callback?.();
      return retVal;
    } catch (err) {
      callback?.(err);
      throw err;
    }
  }

  async length(callback: (err: any, length?: number) => void) {
    try {
      await this.ready;
      const { knex, tableName, sidFieldName, verbose } = this.options;

      let length;
      if (verbose) {
        console.log("session length", knex
          .count(`${sidFieldName} as count`)
          .from(tableName).toSQL())
      }
      const response = await knex
        .count(`${sidFieldName} as count`)
        .from(tableName);

      if (response.length === 1 && "count" in response[0]) {
        length = +(response[0].count ?? 0);
      }

      callback?.(null, length);
      return length;
    } catch (err) {
      callback?.(err);
      throw err;
    }
  }

  async clear(callback?: (err?: any) => void) {
    try {
      await this.ready;
      const { knex, tableName, verbose } = this.options;

      if (verbose) console.log("session clear", knex.del().from(tableName).toSQL());
      const res = await knex.del().from(tableName);
      callback?.();
      return res;
    } catch (err) {
      callback?.(err);
      throw err;
    }
  }

  async all(
    callback: (
      err: any,
      obj?: SessionData[] | { [sid: string]: SessionData } | null,
    ) => void,
  ) {
    try {
      await this.ready;
      const { knex, tableName, verbose } = this.options;

      const condition = expiredCondition(knex);

      if (verbose) {
        console.log("session all", knex
          .select("sess")
          .from(tableName)
          .whereRaw(condition, dateAsISO(knex)).toSQL());
      }

      const rows = await knex
        .select("sess")
        .from(tableName)
        .whereRaw(condition, dateAsISO(knex));

      const sessions = rows.map((row) => {
        if (typeof row.sess === "string") {
          return JSON.parse(row.sess);
        }

        return row.sess;
      });

      callback?.(undefined, sessions);
      return sessions;
    } catch (err) {
      callback?.(err);
      throw err;
    }
  }

  private async dbCleanup() {
    const { cleanupInterval, knex, tableName, onDbCleanupError, verbose } = this.options;

    try {
      await this.ready;

      let condition = `expired < CAST(? as ${timestampTypeName(knex)})`;
      if (isSqlite3(knex)) {
        condition = "datetime(expired) < datetime(?)";
      } else if (isOracle(knex)) {
        condition = `"expired" < CAST(? as ${timestampTypeName(knex)})`;
      }
      if (verbose) console.log("session dbCleanup", knex(tableName).del().whereRaw(condition, dateAsISO(knex)).toSQL());
      await knex(tableName).del().whereRaw(condition, dateAsISO(knex));
    } catch (err: unknown) {
      onDbCleanupError?.(err);
    } finally {
      if (cleanupInterval > 0) {
        this.nextDbCleanup = setTimeout(() => {
          this.dbCleanup();
        }, cleanupInterval).unref();
      }
    }
  }
}
