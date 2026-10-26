// Lightweight, serialisable model of a Java source file, extracted from the tree-sitter syntax tree.

export type Expr =
  | { kind: 'str'; value: string }
  | { kind: 'concat'; parts: Expr[] }
  | { kind: 'ref'; name: string }
  | { kind: 'array'; items: Expr[] }
  | { kind: 'class'; name: string }
  | { kind: 'call'; chain: CallChain }
  | { kind: 'new'; type: string; args: Expr[] }
  | { kind: 'other'; text: string };

export interface Annotation {
  name: string;
  args: Record<string, Expr>;
}

export type Receiver =
  | { kind: 'none' }
  | { kind: 'this' }
  | { kind: 'super' }
  | { kind: 'ident'; name: string }
  | { kind: 'field'; name: string }
  | { kind: 'new'; type: string; args: Expr[] }
  | { kind: 'expr'; text: string };

export interface CallSegment {
  name: string;
  args: Expr[];
}

export interface CallChain {
  receiver: Receiver;
  segments: CallSegment[];
  line: number;
}

export interface Param {
  name: string;
  type: string;
  annotations: Annotation[];
}

export interface MethodInfo {
  name: string;
  params: Param[];
  returnType: string;
  annotations: Annotation[];
  line: number;
  isConstructor: boolean;
  hasBody: boolean;
  calls: CallChain[];
  locals: Record<string, string>;
  localInits: Record<string, Expr>;
  assignments: { field: string; value: Expr }[];
  methodRefs: { target: string; name: string; line: number }[];
}

export interface FieldInfo {
  name: string;
  type: string;
  annotations: Annotation[];
  isStatic: boolean;
  initializer?: Expr;
  line: number;
}

export interface ClassInfo {
  fqn: string;
  name: string;
  pkg: string;
  file: string;
  line: number;
  kind: 'class' | 'interface' | 'record' | 'enum';
  isAbstract: boolean;
  annotations: Annotation[];
  extends: string[];
  implements: string[];
  typeArgs: Record<string, string[]>;
  fields: FieldInfo[];
  methods: MethodInfo[];
  imports: Record<string, string>;
  wildcardImports: string[];
}

export function baseType(type: string): string {
  const t = type.replace(/<.*$/s, '').replace(/\[\]/g, '').replace(/^@\S+\s+/, '').trim();
  return t;
}

export function simpleName(type: string): string {
  const b = baseType(type);
  return b.slice(b.lastIndexOf('.') + 1);
}

export function annotation(list: Annotation[], ...names: string[]): Annotation | undefined {
  return list.find(a => names.includes(simpleName(a.name)));
}

export function annArg(a: Annotation | undefined, ...keys: string[]): Expr | undefined {
  if (!a) return undefined;
  for (const k of keys) if (a.args[k]) return a.args[k];
  return undefined;
}
