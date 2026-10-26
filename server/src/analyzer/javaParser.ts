import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';
import type { Annotation, CallChain, ClassInfo, Expr, FieldInfo, MethodInfo, Param, Receiver } from './javaModel.js';

let parserPromise: Promise<Parser> | undefined;

async function getParser(): Promise<Parser> {
  parserPromise ??= (async () => {
    await Parser.init();
    const require = createRequire(import.meta.url);
    const java = await Language.load(require.resolve('tree-sitter-java/tree-sitter-java.wasm'));
    const parser = new Parser();
    parser.setLanguage(java);
    return parser;
  })();
  return parserPromise;
}

const named = (n: Node | null | undefined): Node[] => (n ? (n.namedChildren.filter(Boolean) as Node[]) : []);
const field = (n: Node, name: string) => n.childForFieldName(name);
const line = (n: Node) => n.startPosition.row + 1;

function stringValue(n: Node): string {
  if (n.type === 'text_block') return n.text.replace(/^"""\s*\n?/, '').replace(/"""$/, '');
  return n.text.length >= 2 ? n.text.slice(1, -1) : n.text;
}

export function toExpr(n: Node | null | undefined): Expr {
  if (!n) return { kind: 'other', text: '' };
  switch (n.type) {
    case 'string_literal':
    case 'text_block':
      return { kind: 'str', value: stringValue(n) };
    case 'binary_expression': {
      const op = n.children.find(c => c && !c.isNamed)?.text;
      if (op === '+') {
        const parts: Expr[] = [];
        for (const side of [field(n, 'left'), field(n, 'right')]) {
          const e = toExpr(side);
          if (e.kind === 'concat') parts.push(...e.parts);
          else parts.push(e);
        }
        return { kind: 'concat', parts };
      }
      return { kind: 'other', text: n.text };
    }
    case 'parenthesized_expression':
      return toExpr(named(n)[0]);
    case 'identifier':
      return { kind: 'ref', name: n.text };
    case 'field_access': {
      const obj = field(n, 'object');
      const f = field(n, 'field');
      if (obj?.type === 'this' && f) return { kind: 'ref', name: f.text };
      return { kind: 'ref', name: n.text };
    }
    case 'scoped_identifier':
      return { kind: 'ref', name: n.text };
    case 'element_value_array_initializer':
    case 'array_initializer':
      return { kind: 'array', items: named(n).map(toExpr) };
    case 'class_literal':
      return { kind: 'class', name: named(n)[0]?.text ?? n.text };
    case 'method_invocation':
      return { kind: 'call', chain: flattenChain(n) };
    case 'object_creation_expression':
      return { kind: 'new', type: field(n, 'type')?.text ?? '', args: named(field(n, 'arguments')).map(toExpr) };
    case 'cast_expression':
      return toExpr(field(n, 'value'));
    default:
      return { kind: 'other', text: n.text.slice(0, 200) };
  }
}

function receiverOf(n: Node | null): Receiver {
  if (!n) return { kind: 'none' };
  switch (n.type) {
    case 'this':
      return { kind: 'this' };
    case 'super':
      return { kind: 'super' };
    case 'identifier':
      return { kind: 'ident', name: n.text };
    case 'field_access': {
      const obj = field(n, 'object');
      const f = field(n, 'field');
      if (obj?.type === 'this' && f) return { kind: 'field', name: f.text };
      return { kind: 'expr', text: n.text };
    }
    case 'object_creation_expression':
      return { kind: 'new', type: field(n, 'type')?.text ?? '', args: named(field(n, 'arguments')).map(toExpr) };
    case 'parenthesized_expression':
      return receiverOf(named(n)[0] ?? null);
    default:
      return { kind: 'expr', text: n.text.slice(0, 200) };
  }
}

function flattenChain(n: Node): CallChain {
  const segments: CallChain['segments'] = [];
  let cur: Node | null = n;
  let receiver: Receiver = { kind: 'none' };
  while (cur && cur.type === 'method_invocation') {
    segments.unshift({ name: field(cur, 'name')?.text ?? '', args: named(field(cur, 'arguments')).map(toExpr) });
    const obj = field(cur, 'object');
    if (obj?.type === 'method_invocation') {
      cur = obj;
    } else {
      receiver = receiverOf(obj);
      cur = null;
    }
  }
  return { receiver, segments, line: line(n) };
}

function annotationsOf(n: Node | null | undefined): Annotation[] {
  const mods = n ? named(n).find(c => c.type === 'modifiers') : undefined;
  return named(mods).filter(c => c.type === 'annotation' || c.type === 'marker_annotation').map(parseAnnotation);
}

function parseAnnotation(n: Node): Annotation {
  const name = field(n, 'name')?.text ?? '';
  const args: Record<string, Expr> = {};
  for (const a of named(field(n, 'arguments'))) {
    if (a.type === 'element_value_pair') {
      const key = field(a, 'key')?.text;
      if (key) args[key] = toExpr(field(a, 'value'));
    } else {
      args.value = toExpr(a);
    }
  }
  return { name, args };
}

function hasModifier(n: Node, mod: string): boolean {
  const mods = named(n).find(c => c.type === 'modifiers');
  return !!mods && mods.children.some(c => c?.text === mod);
}

function typeList(n: Node | null | undefined): string[] {
  if (!n) return [];
  const list = named(n).find(c => c.type === 'type_list');
  return (list ? named(list) : named(n)).map(t => t.text);
}

function typeArgsOf(types: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of types) {
    const m = t.match(/^([\w.]+)\s*<(.*)>$/s);
    if (m) out[m[1].slice(m[1].lastIndexOf('.') + 1)] = splitTypeArgs(m[2]);
  }
  return out;
}

function splitTypeArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseParams(n: Node | null): Param[] {
  return named(n)
    .filter(p => p.type === 'formal_parameter' || p.type === 'spread_parameter')
    .map(p => ({
      name: field(p, 'name')?.text ?? named(p).find(c => c.type === 'variable_declarator')?.text ?? '',
      type: field(p, 'type')?.text ?? named(p).find(c => c.type.endsWith('type') || c.type === 'type_identifier')?.text ?? '',
      annotations: annotationsOf(p)
    }));
}

function walk(n: Node, visit: (n: Node) => boolean | void) {
  if (visit(n) === false) return;
  for (const c of named(n)) walk(c, visit);
}

function parseBody(body: Node | null, m: MethodInfo) {
  if (!body) return;
  walk(body, n => {
    if (n.type === 'class_body') return false;
    if (n.type === 'method_invocation') {
      const parent = n.parent;
      const isInnerOfChain = parent?.type === 'method_invocation' && field(parent, 'object')?.id === n.id;
      if (!isInnerOfChain) m.calls.push(flattenChain(n));
    } else if (n.type === 'local_variable_declaration') {
      const type = field(n, 'type')?.text ?? '';
      for (const d of named(n).filter(c => c.type === 'variable_declarator')) {
        const name = field(d, 'name')?.text;
        if (!name) continue;
        m.locals[name] = type;
        const value = field(d, 'value');
        if (value) m.localInits[name] = toExpr(value);
      }
    } else if (n.type === 'enhanced_for_statement' || n.type === 'catch_formal_parameter') {
      const name = field(n, 'name')?.text;
      const type = field(n, 'type')?.text ?? named(n).find(c => c.type === 'catch_type')?.text;
      if (name && type) m.locals[name] = type;
    } else if (n.type === 'assignment_expression') {
      const left = field(n, 'left');
      const right = field(n, 'right');
      if (left && right) {
        const target =
          left.type === 'field_access' && field(left, 'object')?.type === 'this'
            ? field(left, 'field')?.text
            : left.type === 'identifier'
              ? left.text
              : undefined;
        if (target) m.assignments.push({ field: target, value: toExpr(right) });
      }
    } else if (n.type === 'method_reference') {
      const parts = named(n);
      if (parts.length >= 2) m.methodRefs.push({ target: parts[0].text, name: parts[parts.length - 1].text, line: line(n) });
    }
  });
}

function parseMethod(n: Node, isConstructor: boolean): MethodInfo {
  const body = field(n, 'body');
  const m: MethodInfo = {
    name: isConstructor ? '<init>' : (field(n, 'name')?.text ?? ''),
    params: parseParams(field(n, 'parameters')),
    returnType: field(n, 'type')?.text ?? '',
    annotations: annotationsOf(n),
    line: line(n),
    isConstructor,
    hasBody: !!body,
    calls: [],
    locals: {},
    localInits: {},
    assignments: [],
    methodRefs: []
  };
  parseBody(body, m);
  return m;
}

function parseFields(n: Node): FieldInfo[] {
  const type = field(n, 'type')?.text ?? '';
  const annotations = annotationsOf(n);
  const isStatic = hasModifier(n, 'static');
  return named(n)
    .filter(c => c.type === 'variable_declarator')
    .map(d => {
      const value = field(d, 'value');
      return { name: field(d, 'name')?.text ?? '', type, annotations, isStatic, initializer: value ? toExpr(value) : undefined, line: line(d) };
    });
}

const TYPE_DECLS = new Set(['class_declaration', 'interface_declaration', 'record_declaration', 'enum_declaration']);

function parseType(
  n: Node,
  ctx: { pkg: string; file: string; imports: Record<string, string>; wildcardImports: string[] },
  outerName: string | undefined,
  out: ClassInfo[]
) {
  const name = field(n, 'name')?.text ?? '';
  const qualified = outerName ? `${outerName}.${name}` : name;
  const kind = n.type === 'interface_declaration' ? 'interface' : n.type === 'record_declaration' ? 'record' : n.type === 'enum_declaration' ? 'enum' : 'class';
  let ext: string[] = [];
  let impl: string[] = [];
  if (kind === 'interface') {
    ext = typeList(named(n).find(c => c.type === 'extends_interfaces'));
  } else {
    const sup = field(n, 'superclass');
    if (sup) ext = named(sup).map(t => t.text);
    impl = typeList(field(n, 'interfaces') ?? named(n).find(c => c.type === 'super_interfaces'));
  }
  const cls: ClassInfo = {
    fqn: ctx.pkg ? `${ctx.pkg}.${qualified}` : qualified,
    name,
    pkg: ctx.pkg,
    file: ctx.file,
    line: line(n),
    kind,
    isAbstract: hasModifier(n, 'abstract'),
    annotations: annotationsOf(n),
    extends: ext,
    implements: impl,
    typeArgs: typeArgsOf([...ext, ...impl]),
    fields: [],
    methods: [],
    imports: ctx.imports,
    wildcardImports: ctx.wildcardImports
  };
  if (kind === 'record') {
    for (const p of parseParams(field(n, 'parameters'))) {
      cls.fields.push({ name: p.name, type: p.type, annotations: p.annotations, isStatic: false, line: cls.line });
    }
  }
  out.push(cls);
  const body = field(n, 'body');
  const members = named(body).flatMap(c => (c.type === 'enum_body_declarations' ? named(c) : [c]));
  for (const member of members) {
    switch (member.type) {
      case 'field_declaration':
      case 'constant_declaration':
        cls.fields.push(...parseFields(member));
        break;
      case 'method_declaration':
        cls.methods.push(parseMethod(member, false));
        break;
      case 'constructor_declaration':
      case 'compact_constructor_declaration':
        cls.methods.push(parseMethod(member, true));
        break;
      default:
        if (TYPE_DECLS.has(member.type)) parseType(member, ctx, qualified, out);
    }
  }
}

export async function parseJavaFile(source: string, file: string): Promise<ClassInfo[]> {
  const parser = await getParser();
  const tree = parser.parse(source);
  if (!tree) return [];
  try {
    const root = tree.rootNode;
    let pkg = '';
    const imports: Record<string, string> = {};
    const wildcardImports: string[] = [];
    for (const c of named(root)) {
      if (c.type === 'package_declaration') {
        pkg = named(c).find(x => x.type === 'scoped_identifier' || x.type === 'identifier')?.text ?? '';
      } else if (c.type === 'import_declaration') {
        const id = named(c).find(x => x.type === 'scoped_identifier' || x.type === 'identifier')?.text ?? '';
        const isWildcard = named(c).some(x => x.type === 'asterisk');
        const isStatic = c.children.some(x => x?.text === 'static');
        if (isWildcard) wildcardImports.push(id);
        else if (!isStatic) imports[id.slice(id.lastIndexOf('.') + 1)] = id;
        else imports[id.slice(id.lastIndexOf('.') + 1)] = id;
      }
    }
    const out: ClassInfo[] = [];
    for (const c of named(root)) {
      if (TYPE_DECLS.has(c.type)) parseType(c, { pkg, file, imports, wildcardImports }, undefined, out);
    }
    return out;
  } finally {
    tree.delete();
  }
}
