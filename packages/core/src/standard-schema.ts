/**
 * Vendored Standard Schema V1 interface (https://standardschema.dev, MIT).
 * The spec explicitly allows copying the interface instead of depending on a package.
 * Any compliant validator (Zod 4, Valibot, ArkType, Effect Schema, ...) can be used in a contract.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult;
  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  export interface PathSegment {
    readonly key: PropertyKey;
  }
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
  export type InferInput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['input'];
  export type InferOutput<S extends StandardSchemaV1> = NonNullable<S['~standard']['types']>['output'];
}

/** Schema slot that may be unset. `undefined` means "no schema declared". */
export type AnySchema = StandardSchemaV1<any, any>;
export type SchemaInput<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferInput<S> : undefined;
export type SchemaOutput<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : undefined;

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: ReadonlyArray<StandardSchemaV1.Issue> };

/** Runs a Standard Schema validator. With no schema, the value passes through unchanged. */
export async function validateSchema<S extends AnySchema | undefined>(
  schema: S,
  value: unknown,
): Promise<ValidationResult<SchemaOutput<S>>> {
  if (!schema) return { ok: true, value: value as SchemaOutput<S> };
  const result = await schema['~standard'].validate(value);
  if (result.issues) return { ok: false, issues: result.issues };
  return { ok: true, value: result.value as SchemaOutput<S> };
}

/** One-line summary of validation issues, for error messages. */
export function formatIssues(issues: ReadonlyArray<StandardSchemaV1.Issue>): string {
  return issues
    .map((issue) => {
      const path = issue.path?.map((p) => (typeof p === 'object' ? String(p.key) : String(p))).join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}
