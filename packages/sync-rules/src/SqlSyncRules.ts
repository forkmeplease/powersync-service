import { isScalar, LineCounter, parseDocument, Scalar, YAMLMap, YAMLSeq } from 'yaml';
import { BucketPriority, isValidPriority } from './BucketDescription.js';
import { BucketParameterQuerier, mergeBucketParameterQueriers } from './BucketParameterQuerier.js';
import { SqlRuleError, SyncRulesErrors, YamlError } from './errors.js';
import { SqlEventDescriptor } from './events/SqlEventDescriptor.js';
import { IdSequence } from './IdSequence.js';
import { validateSyncRulesSchema } from './json_schema.js';
import { SourceTableInterface } from './SourceTableInterface.js';
import { QueryParseResult, SqlBucketDescriptor } from './SqlBucketDescriptor.js';
import { TablePattern } from './TablePattern.js';
import {
  EvaluatedParameters,
  EvaluatedParametersResult,
  EvaluatedRow,
  EvaluateRowOptions,
  EvaluationError,
  EvaluationResult,
  isEvaluatedParameters,
  isEvaluatedRow,
  isEvaluationError,
  QueryParseOptions,
  RequestParameters,
  SourceSchema,
  SqliteRow,
  SyncRules
} from './types.js';

const ACCEPT_POTENTIALLY_DANGEROUS_QUERIES = Symbol('ACCEPT_POTENTIALLY_DANGEROUS_QUERIES');

export interface SyncRulesOptions {
  schema?: SourceSchema;
  /**
   * The default schema to use when only a table name is specified.
   *
   * 'public' for Postgres, default database for MongoDB/MySQL.
   */
  defaultSchema: string;

  throwOnError?: boolean;
}

export class SqlSyncRules implements SyncRules {
  bucketDescriptors: SqlBucketDescriptor[] = [];
  eventDescriptors: SqlEventDescriptor[] = [];

  content: string;

  errors: YamlError[] = [];

  static validate(yaml: string, options: SyncRulesOptions): YamlError[] {
    try {
      const rules = this.fromYaml(yaml, options);
      return rules.errors;
    } catch (e) {
      if (e instanceof SyncRulesErrors) {
        return e.errors;
      } else if (e instanceof YamlError) {
        return [e];
      } else {
        return [new YamlError(e)];
      }
    }
  }

  static fromYaml(yaml: string, options: SyncRulesOptions) {
    const throwOnError = options.throwOnError ?? true;

    const lineCounter = new LineCounter();
    const parsed = parseDocument(yaml, {
      schema: 'core',
      keepSourceTokens: true,
      lineCounter,
      customTags: [
        {
          tag: '!accept_potentially_dangerous_queries',
          resolve(_text: string, _onError: (error: string) => void) {
            return ACCEPT_POTENTIALLY_DANGEROUS_QUERIES;
          }
        }
      ]
    });

    const rules = new SqlSyncRules(yaml);

    if (parsed.errors.length > 0) {
      rules.errors.push(
        ...parsed.errors.map((error) => {
          return new YamlError(error);
        })
      );

      if (throwOnError) {
        rules.throwOnError();
      }
      return rules;
    }

    const bucketMap = parsed.get('bucket_definitions') as YAMLMap;
    if (bucketMap == null) {
      rules.errors.push(new YamlError(new Error(`'bucket_definitions' is required`)));

      if (throwOnError) {
        rules.throwOnError();
      }
      return rules;
    }

    for (let entry of bucketMap.items) {
      const { key: keyScalar, value } = entry as { key: Scalar; value: YAMLMap };
      const key = keyScalar.toString();

      if (value == null || !(value instanceof YAMLMap)) {
        rules.errors.push(this.tokenError(keyScalar, `'${key}' bucket definition must be an object`));
        continue;
      }

      const accept_potentially_dangerous_queries =
        value.get('accept_potentially_dangerous_queries', true)?.value == true;
      let parseOptionPriority: BucketPriority | undefined = undefined;
      if (value.has('priority')) {
        const priorityValue = value.get('priority', true)!;
        if (typeof priorityValue.value != 'number' || !isValidPriority(priorityValue.value)) {
          rules.errors.push(
            this.tokenError(priorityValue, 'Invalid priority, expected a number between 0 and 3 (inclusive).')
          );
        } else {
          parseOptionPriority = priorityValue.value;
        }
      }

      const queryOptions: QueryParseOptions = {
        ...options,
        accept_potentially_dangerous_queries,
        priority: parseOptionPriority
      };
      const parameters = value.get('parameters', true) as unknown;
      const dataQueries = value.get('data', true) as unknown;

      const descriptor = new SqlBucketDescriptor(key);

      if (parameters instanceof Scalar) {
        rules.withScalar(parameters, (q) => {
          return descriptor.addParameterQuery(q, queryOptions);
        });
      } else if (parameters instanceof YAMLSeq) {
        for (let item of parameters.items) {
          rules.withScalar(item, (q) => {
            return descriptor.addParameterQuery(q, queryOptions);
          });
        }
      } else {
        descriptor.addParameterQuery('SELECT', queryOptions);
      }

      if (!(dataQueries instanceof YAMLSeq)) {
        rules.errors.push(this.tokenError(dataQueries ?? value, `'data' must be an array`));
        continue;
      }
      for (let query of dataQueries.items) {
        rules.withScalar(query, (q) => {
          return descriptor.addDataQuery(q, queryOptions);
        });
      }
      rules.bucketDescriptors.push(descriptor);
    }

    const eventMap = parsed.get('event_definitions') as YAMLMap;
    for (const event of eventMap?.items ?? []) {
      const { key, value } = event as { key: Scalar; value: YAMLSeq };

      if (false == value instanceof YAMLMap) {
        rules.errors.push(new YamlError(new Error(`Event definitions must be objects.`)));
        continue;
      }

      const payloads = value.get('payloads') as YAMLSeq;
      if (false == payloads instanceof YAMLSeq) {
        rules.errors.push(new YamlError(new Error(`Event definition payloads must be an array.`)));
        continue;
      }

      const eventDescriptor = new SqlEventDescriptor(key.toString());
      for (let item of payloads.items) {
        if (!isScalar(item)) {
          rules.errors.push(new YamlError(new Error(`Payload queries for events must be scalar.`)));
          continue;
        }
        rules.withScalar(item, (q) => {
          return eventDescriptor.addSourceQuery(q, options);
        });
      }

      rules.eventDescriptors.push(eventDescriptor);
    }

    // Validate that there are no additional properties.
    // Since these errors don't contain line numbers, do this last.
    const valid = validateSyncRulesSchema(parsed.toJSON());
    if (!valid) {
      rules.errors.push(
        ...validateSyncRulesSchema.errors!.map((e: any) => {
          return new YamlError(e);
        })
      );
    }

    if (throwOnError) {
      rules.throwOnError();
    }

    return rules;
  }

  throwOnError() {
    if (this.errors.filter((e) => e.type != 'warning').length > 0) {
      throw new SyncRulesErrors(this.errors);
    }
  }

  static tokenError(token: any, message: string) {
    const start = token?.srcToken?.offset ?? 0;
    const end = start + 1;
    return new YamlError(new Error(message), { start, end });
  }

  withScalar(scalar: Scalar, cb: (value: string) => QueryParseResult) {
    const value = scalar.toString();

    const wrapped = (value: string): QueryParseResult => {
      try {
        return cb(value);
      } catch (e) {
        return {
          parsed: false,
          errors: [e]
        };
      }
    };

    const result = wrapped(value);
    for (let err of result.errors) {
      let sourceOffset = scalar.srcToken!.offset;
      if (scalar.type == Scalar.QUOTE_DOUBLE || scalar.type == Scalar.QUOTE_SINGLE) {
        // TODO: Is there a better way to do this?
        sourceOffset += 1;
      }
      let offset: number;
      let end: number;
      if (err instanceof SqlRuleError && err.location) {
        offset = err.location!.start + sourceOffset;
        end = err.location!.end + sourceOffset;
      } else if (typeof (err as any).token?._location?.start == 'number') {
        offset = sourceOffset + (err as any).token?._location?.start;
        end = sourceOffset + (err as any).token?._location?.end;
      } else {
        offset = sourceOffset;
        end = sourceOffset + Math.max(value.length, 1);
      }

      const pos = { start: offset, end };
      this.errors.push(new YamlError(err, pos));
    }
    return result;
  }

  constructor(content: string) {
    this.content = content;
  }

  /**
   * Throws errors.
   */
  evaluateRow(options: EvaluateRowOptions): EvaluatedRow[] {
    const { results, errors } = this.evaluateRowWithErrors(options);
    if (errors.length > 0) {
      throw new Error(errors[0].error);
    }
    return results;
  }

  evaluateRowWithErrors(options: EvaluateRowOptions): { results: EvaluatedRow[]; errors: EvaluationError[] } {
    let rawResults: EvaluationResult[] = [];
    for (let query of this.bucketDescriptors) {
      rawResults.push(...query.evaluateRow(options));
    }

    const results = rawResults.filter(isEvaluatedRow) as EvaluatedRow[];
    const errors = rawResults.filter(isEvaluationError) as EvaluationError[];

    return { results, errors };
  }

  /**
   * Throws errors.
   */
  evaluateParameterRow(table: SourceTableInterface, row: SqliteRow): EvaluatedParameters[] {
    const { results, errors } = this.evaluateParameterRowWithErrors(table, row);
    if (errors.length > 0) {
      throw new Error(errors[0].error);
    }
    return results;
  }

  evaluateParameterRowWithErrors(
    table: SourceTableInterface,
    row: SqliteRow
  ): { results: EvaluatedParameters[]; errors: EvaluationError[] } {
    let rawResults: EvaluatedParametersResult[] = [];
    for (let query of this.bucketDescriptors) {
      rawResults.push(...query.evaluateParameterRow(table, row));
    }

    const results = rawResults.filter(isEvaluatedParameters) as EvaluatedParameters[];
    const errors = rawResults.filter(isEvaluationError) as EvaluationError[];
    return { results, errors };
  }

  getBucketParameterQuerier(parameters: RequestParameters): BucketParameterQuerier {
    const queriers = this.bucketDescriptors.map((query) => query.getBucketParameterQuerier(parameters));
    return mergeBucketParameterQueriers(queriers);
  }

  hasDynamicBucketQueries() {
    return this.bucketDescriptors.some((query) => query.hasDynamicBucketQueries());
  }

  getSourceTables(): TablePattern[] {
    const sourceTables = new Map<String, TablePattern>();
    for (const bucket of this.bucketDescriptors) {
      for (const r of bucket.getSourceTables()) {
        const key = `${r.connectionTag}.${r.schema}.${r.tablePattern}`;
        sourceTables.set(key, r);
      }
    }

    for (const event of this.eventDescriptors) {
      for (const r of event.getSourceTables()) {
        const key = `${r.connectionTag}.${r.schema}.${r.tablePattern}`;
        sourceTables.set(key, r);
      }
    }

    return [...sourceTables.values()];
  }

  getEventTables(): TablePattern[] {
    const eventTables = new Map<String, TablePattern>();

    for (const event of this.eventDescriptors) {
      for (const r of event.getSourceTables()) {
        const key = `${r.connectionTag}.${r.schema}.${r.tablePattern}`;
        eventTables.set(key, r);
      }
    }
    return [...eventTables.values()];
  }

  tableTriggersEvent(table: SourceTableInterface): boolean {
    return this.eventDescriptors.some((bucket) => bucket.tableTriggersEvent(table));
  }

  tableSyncsData(table: SourceTableInterface): boolean {
    for (const bucket of this.bucketDescriptors) {
      if (bucket.tableSyncsData(table)) {
        return true;
      }
    }
    return false;
  }

  tableSyncsParameters(table: SourceTableInterface): boolean {
    for (let bucket of this.bucketDescriptors) {
      if (bucket.tableSyncsParameters(table)) {
        return true;
      }
    }
    return false;
  }

  debugGetOutputTables() {
    let result: Record<string, any[]> = {};
    for (let bucket of this.bucketDescriptors) {
      for (let q of bucket.dataQueries) {
        result[q.table!] ??= [];
        const r = {
          query: q.sql
        };

        result[q.table!].push(r);
      }
    }
    return result;
  }
}
