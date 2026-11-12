/**
 * 외부 의존성 없는 JSON Schema 검증기 (draft 2020-12 부분집합).
 * 지원: type, enum, const, required, properties, additionalProperties, items, minItems, maxItems,
 *      minimum, maximum, minLength, pattern, $ref(같은 파일 #/$defs/…, 다른 파일 x.schema.json[#/…]), anyOf, oneOf.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Schema = Record<string, unknown>;
export interface SchemaError { path: string; message: string }

export class SchemaSet {
  private dir: string;
  private cache = new Map<string, Schema>();

  constructor(dir: string) {
    this.dir = dir;
  }

  load(file: string): Schema {
    let s = this.cache.get(file);
    if (!s) {
      s = JSON.parse(readFileSync(join(this.dir, file), "utf8")) as Schema;
      this.cache.set(file, s);
    }
    return s;
  }

  validate(file: string, value: unknown): SchemaError[] {
    const errors: SchemaError[] = [];
    this.check(this.load(file), file, value, "$", errors);
    return errors;
  }

  private resolve(ref: string, currentFile: string): { schema: Schema; file: string } {
    const [filePart, pointer] = ref.split("#");
    const file = filePart || currentFile;
    let node: unknown = this.load(file);
    for (const key of (pointer ?? "").split("/").filter(Boolean)) node = (node as Schema)[key];
    if (!node) throw new Error(`$ref 해석 실패: ${ref} (${currentFile})`);
    return { schema: node as Schema, file };
  }

  private check(schema: Schema, file: string, v: unknown, path: string, errors: SchemaError[]): void {
    const err = (message: string) => errors.push({ path, message });
    if (typeof schema.$ref === "string") {
      const r = this.resolve(schema.$ref, file);
      this.check(r.schema, r.file, v, path, errors);
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((t) => typeOk(t as string, v))) return err(`type ${types.join("|")} 아님 (${jsType(v)})`);
    }
    if ("const" in schema && !deepEqual(schema.const, v)) err(`const ${JSON.stringify(schema.const)} 아님`);
    if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, v))) err(`enum ${JSON.stringify(schema.enum)} 밖: ${JSON.stringify(v)}`);
    if (typeof v === "number") {
      if (typeof schema.minimum === "number" && v < schema.minimum) err(`최솟값 ${schema.minimum} 미만`);
      if (typeof schema.maximum === "number" && v > schema.maximum) err(`최댓값 ${schema.maximum} 초과`);
    }
    if (typeof v === "string") {
      if (typeof schema.minLength === "number" && v.length < schema.minLength) err(`길이 ${schema.minLength} 미만`);
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(v)) err(`pattern ${schema.pattern} 불일치: ${v}`);
    }
    if (Array.isArray(v)) {
      if (typeof schema.minItems === "number" && v.length < schema.minItems) err(`항목 ${schema.minItems}개 미만`);
      if (typeof schema.maxItems === "number" && v.length > schema.maxItems) err(`항목 ${schema.maxItems}개 초과`);
      if (schema.items) v.forEach((item, i) => this.check(schema.items as Schema, file, item, `${path}[${i}]`, errors));
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      for (const key of (schema.required as string[] | undefined) ?? []) if (!(key in obj)) err(`필수 속성 누락: ${key}`);
      const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
      for (const [key, val] of Object.entries(obj)) {
        if (props[key]) this.check(props[key], file, val, `${path}.${key}`, errors);
        else if (schema.additionalProperties === false) err(`허용되지 않은 속성: ${key}`);
        else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          this.check(schema.additionalProperties as Schema, file, val, `${path}.${key}`, errors);
        }
      }
    }
    if (Array.isArray(schema.anyOf)) {
      const ok = schema.anyOf.some((s) => this.sub(s as Schema, file, v, path).length === 0);
      if (!ok) err("anyOf 어느 것도 만족하지 않음");
    }
    if (Array.isArray(schema.oneOf)) {
      const results = schema.oneOf.map((s) => this.sub(s as Schema, file, v, path));
      const passed = results.filter((r) => r.length === 0).length;
      if (passed !== 1) {
        const best = results.reduce((a, b) => (b.length < a.length ? b : a));
        err(`oneOf ${passed}개 만족 (가장 가까운 후보 오류: ${best.map((e) => `${e.path} ${e.message}`).join("; ")})`);
      }
    }
  }

  private sub(schema: Schema, file: string, v: unknown, path: string): SchemaError[] {
    const e: SchemaError[] = [];
    this.check(schema, file, v, path, e);
    return e;
  }
}

function jsType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function typeOk(t: string, v: unknown): boolean {
  switch (t) {
    case "integer": return Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "object": return jsType(v) === "object";
    default: return jsType(v) === t;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
