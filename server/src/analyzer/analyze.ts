import { readFileSync } from 'node:fs';
import path from 'node:path';
import { listIndexed, loadModuleProps, resolvePlaceholders, type Props } from './config.js';
import { findModules } from './discover.js';
import { parseJavaFile } from './javaParser.js';
import {
  annArg,
  annotation,
  baseType,
  simpleName,
  type Annotation,
  type CallChain,
  type ClassInfo,
  type Expr,
  type MethodInfo
} from './javaModel.js';
import type { Confidence, EdgeKind, Endpoint, GraphEdge, GraphNode, HttpMethod, ScanResult, ServiceInfo, SourceRef } from './types.js';

export interface RepoInput {
  repo: string;
  dir: string;
  webUrl?: (relFile: string, line: number) => string | undefined;
  repoWebUrl?: string;
}

export interface ServiceModel {
  name: string;
  aliases: Set<string>;
  repo: RepoInput;
  moduleDir: string;
  props: Props;
  contextPath: string;
  classes: ClassInfo[];
  byFqn: Map<string, ClassInfo>;
  bySimple: Map<string, ClassInfo[]>;
}

interface OutboundHttp {
  from: string;
  service: ServiceModel;
  method: HttpMethod;
  url: string;
  targetService?: string;
  via: string;
  ref: SourceRef;
}

const MAPPING: Record<string, HttpMethod | null> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
  RequestMapping: null,
  GetExchange: 'GET',
  PostExchange: 'POST',
  PutExchange: 'PUT',
  DeleteExchange: 'DELETE',
  PatchExchange: 'PATCH',
  HttpExchange: null
};
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);
const DYN = '{*}';

export async function analyzeRepos(repos: RepoInput[], onProgress: (msg: string) => void = () => {}): Promise<ScanResult> {
  const warnings: string[] = [];
  const services: ServiceModel[] = [];

  for (const repo of repos) {
    const modules = findModules(repo.dir);
    if (!modules.length) warnings.push(`${repo.repo}: no Maven/Gradle module (src/main) found`);
    for (const mod of modules) {
      const props = loadModuleProps(mod.dir);
      const rel = path.relative(repo.dir, mod.dir) || '.';
      const name = props['spring.application.name'] ? resolvePlaceholders(props['spring.application.name'], props) : mod.artifactId || (rel === '.' ? repo.repo.split('/').pop()! : path.basename(mod.dir));
      const classes: ClassInfo[] = [];
      for (const f of mod.javaFiles) {
        try {
          classes.push(...(await parseJavaFile(readFileSync(f, 'utf8'), path.relative(repo.dir, f))));
        } catch (e) {
          warnings.push(`${repo.repo}/${path.relative(repo.dir, f)}: parse failed (${(e as Error).message})`);
        }
      }
      if (!classes.length && !Object.keys(props).length) continue;
      const svc: ServiceModel = {
        name,
        aliases: new Set([name, mod.artifactId, path.basename(mod.dir), rel === '.' ? repo.repo.split('/').pop() : undefined].filter(Boolean).map(s => s!.toLowerCase())),
        repo,
        moduleDir: rel,
        props,
        contextPath: normalizePath(resolvePlaceholders(props['server.servlet.context-path'] ?? props['server.servlet.contextPath'] ?? props['spring.webflux.base-path'] ?? '', props)),
        classes,
        byFqn: new Map(classes.map(c => [c.fqn, c])),
        bySimple: new Map()
      };
      for (const c of classes) {
        const list = svc.bySimple.get(c.name) ?? [];
        list.push(c);
        svc.bySimple.set(c.name, list);
      }
      services.push(svc);
      onProgress(`Parsed ${name} (${repo.repo}${rel === '.' ? '' : `/${rel}`}): ${classes.length} types`);
    }
  }

  const dupes = new Map<string, number>();
  for (const s of services) dupes.set(s.name, (dupes.get(s.name) ?? 0) + 1);
  for (const s of services) {
    if ((dupes.get(s.name) ?? 0) > 1) {
      warnings.push(`Service name "${s.name}" is used by more than one module; renamed to "${s.name}@${s.repo.repo}/${s.moduleDir}"`);
      s.name = `${s.name}@${s.repo.repo}/${s.moduleDir}`;
    }
  }

  const g = new GraphBuilder();
  const endpoints: Endpoint[] = [];
  for (const svc of services) endpoints.push(...extractEndpoints(svc, g));
  onProgress(`Found ${endpoints.length} REST endpoints in ${services.length} services`);

  const outbound: OutboundHttp[] = [];
  const listeners: { node: string; broker: string; dest: string }[] = [];
  for (const svc of services) {
    for (const cls of svc.classes) {
      for (const m of cls.methods) {
        if (!m.hasBody && !m.isConstructor) continue;
        new MethodAnalyzer(svc, cls, m, g, outbound).run();
        for (const l of listenerTopics(svc, cls, m)) {
          const node = g.methodNode(svc, cls, m.name, m.line);
          node.kind = 'listener';
          node.detail = `${l.broker} listener: ${l.dest}`;
          listeners.push({ node: node.id, ...l });
        }
      }
    }
  }

  for (const l of listeners) {
    const topic = g.topicNode(l.broker, l.dest);
    g.edge(topic.id, l.node, 'consumes', 'high');
  }

  linkHttp(outbound, services, endpoints, g);
  linkGateways(services, endpoints, g, warnings);
  onProgress(`Built graph: ${g.nodes.size} nodes, ${g.edges.size} edges`);

  const serviceInfos: ServiceInfo[] = services.map(s => ({
    name: s.name,
    repo: s.repo.repo,
    modulePath: s.moduleDir,
    webUrl: s.repo.repoWebUrl,
    endpointCount: endpoints.filter(e => e.service === s.name).length,
    classCount: s.classes.length,
    contextPath: s.contextPath
  }));

  return { services: serviceInfos, endpoints, nodes: [...g.nodes.values()], edges: [...g.edges.values()], warnings };
}

// ---------------------------------------------------------------------------------------------
// Graph builder

class GraphBuilder {
  nodes = new Map<string, GraphNode>();
  edges = new Map<string, GraphEdge>();

  node(n: GraphNode): GraphNode {
    const existing = this.nodes.get(n.id);
    if (existing) return existing;
    this.nodes.set(n.id, n);
    return n;
  }

  edge(source: string, target: string, kind: EdgeKind, confidence: Confidence, label?: string, ref?: SourceRef) {
    if (source === target) return;
    const id = `${source}->${target}:${kind}`;
    const existing = this.edges.get(id);
    if (existing) {
      if (label && existing.label && !existing.label.split(', ').includes(label)) existing.label = `${existing.label}, ${label}`;
      return;
    }
    this.edges.set(id, { id, source, target, kind, confidence, label, ref });
  }

  methodNode(svc: ServiceModel, cls: ClassInfo, method: string, line?: number): GraphNode {
    const decl = cls.methods.find(m => m.name === method);
    return this.node({
      id: `m:${svc.name}:${cls.fqn}#${method}`,
      kind: 'method',
      label: `${cls.name}.${method}()`,
      service: svc.name,
      className: cls.fqn,
      ref: ref(svc, cls.file, decl?.line ?? line ?? cls.line)
    });
  }

  topicNode(broker: string, dest: string): GraphNode {
    return this.node({ id: `topic:${dest}`, kind: 'topic', label: dest, detail: broker });
  }
}

function ref(svc: ServiceModel, file: string, line: number): SourceRef {
  return { service: svc.name, file, line, url: svc.repo.webUrl?.(file, line) };
}

// ---------------------------------------------------------------------------------------------
// Type resolution and constant evaluation

function resolveType(svc: ServiceModel, cls: ClassInfo, type: string | undefined): ClassInfo | undefined {
  if (!type) return undefined;
  const base = baseType(type);
  if (!base || /^[a-z]/.test(base) && !base.includes('.')) return undefined;
  const [first, ...rest] = base.split('.');
  const suffix = rest.length ? `.${rest.join('.')}` : '';
  const candidates = [
    base,
    cls.imports[first] ? cls.imports[first] + suffix : undefined,
    `${cls.fqn}.${base}`,
    cls.pkg ? `${cls.pkg}.${base}` : base,
    ...cls.wildcardImports.map(w => `${w}.${base}`)
  ];
  for (const c of candidates) if (c && svc.byFqn.has(c)) return svc.byFqn.get(c);
  if (cls.imports[first] && !svc.byFqn.has(cls.imports[first])) return undefined;
  const bySimple = svc.bySimple.get(simpleName(base)) ?? [];
  if (bySimple.length === 1) return bySimple[0];
  return bySimple.find(c => c.pkg.split('.').slice(0, 2).join('.') === cls.pkg.split('.').slice(0, 2).join('.'));
}

function ancestors(svc: ServiceModel, cls: ClassInfo, seen = new Set<string>()): ClassInfo[] {
  if (seen.has(cls.fqn)) return [];
  seen.add(cls.fqn);
  const out: ClassInfo[] = [];
  for (const t of [...cls.extends, ...cls.implements]) {
    const p = resolveType(svc, cls, t);
    if (p) out.push(p, ...ancestors(svc, p, seen));
  }
  return out;
}

function findField(svc: ServiceModel, cls: ClassInfo, name: string) {
  for (const c of [cls, ...ancestors(svc, cls)]) {
    const f = c.fields.find(x => x.name === name);
    if (f) return { field: f, owner: c };
  }
  return undefined;
}

function evalExpr(svc: ServiceModel, cls: ClassInfo, method: MethodInfo | undefined, e: Expr | undefined, depth = 0): string | undefined {
  if (!e || depth > 10) return undefined;
  switch (e.kind) {
    case 'str':
      return resolvePlaceholders(e.value, svc.props);
    case 'concat':
      return e.parts.map(p => evalExpr(svc, cls, method, p, depth + 1) ?? DYN).join('');
    case 'ref':
      return evalRef(svc, cls, method, e.name, depth);
    case 'call': {
      const segs = e.chain.segments;
      const recv = e.chain.receiver;
      if (recv.kind === 'ident' && recv.name === 'String' && segs[0]?.name === 'format') {
        const fmt = evalExpr(svc, cls, method, segs[0].args[0], depth + 1);
        return fmt?.replace(/%[sdf]/g, DYN);
      }
      if (recv.kind === 'ident' && /UriComponentsBuilder|ServletUriComponentsBuilder/.test(recv.name)) {
        let url = '';
        for (const s of segs) {
          if (/^(fromHttpUrl|fromUriString|fromPath|path|pathSegment)$/.test(s.name)) {
            const v = evalExpr(svc, cls, method, s.args[0], depth + 1) ?? DYN;
            url += s.name === 'pathSegment' ? `/${v}` : v;
          }
        }
        return url || undefined;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

function valueAnnotation(list: Annotation[]): Expr | undefined {
  return annArg(annotation(list, 'Value'), 'value');
}

function evalRef(svc: ServiceModel, cls: ClassInfo, method: MethodInfo | undefined, name: string, depth: number): string | undefined {
  if (!name.includes('.')) {
    if (method) {
      if (method.localInits[name]) return evalExpr(svc, cls, method, method.localInits[name], depth + 1);
      const p = method.params.find(x => x.name === name);
      if (p) {
        const v = valueAnnotation(p.annotations);
        return v ? evalExpr(svc, cls, undefined, v, depth + 1) : undefined;
      }
    }
    const found = findField(svc, cls, name);
    if (found) return evalField(svc, found.owner, found.field.name, depth);
    const imp = cls.imports[name];
    if (imp) {
      const owner = svc.byFqn.get(imp.slice(0, imp.lastIndexOf('.')));
      if (owner) return evalField(svc, owner, name, depth);
    }
    return undefined;
  }
  const idx = name.lastIndexOf('.');
  const owner = resolveType(svc, cls, name.slice(0, idx));
  return owner ? evalField(svc, owner, name.slice(idx + 1), depth) : undefined;
}

function evalField(svc: ServiceModel, cls: ClassInfo, name: string, depth: number): string | undefined {
  const f = cls.fields.find(x => x.name === name);
  if (!f) return undefined;
  const v = valueAnnotation(f.annotations);
  if (v) return evalExpr(svc, cls, undefined, v, depth + 1);
  if (f.initializer) return evalExpr(svc, cls, undefined, f.initializer, depth + 1);
  for (const ctor of cls.methods.filter(m => m.isConstructor)) {
    const a = ctor.assignments.find(x => x.field === name);
    if (a) return evalExpr(svc, cls, ctor, a.value, depth + 1);
  }
  return undefined;
}

function evalStrings(svc: ServiceModel, cls: ClassInfo, e: Expr | undefined): string[] {
  if (!e) return [];
  if (e.kind === 'array') return e.items.map(i => evalExpr(svc, cls, undefined, i) ?? DYN);
  const v = evalExpr(svc, cls, undefined, e);
  return v === undefined ? [] : [v];
}

// ---------------------------------------------------------------------------------------------
// Endpoints

export function normalizePath(p: string): string {
  let out = `/${p}`.replace(/\/+/g, '/').replace(/\{([^}:]+):[^}]*\}/g, '{$1}');
  if (out.length > 1) out = out.replace(/\/$/, '');
  return out === '/' ? '' : out;
}

function joinPaths(...parts: string[]): string {
  return normalizePath(parts.filter(Boolean).join('/')) || '/';
}

function mappingOf(svc: ServiceModel, cls: ClassInfo, anns: Annotation[]): { methods: HttpMethod[]; paths: string[] } | undefined {
  for (const a of anns) {
    const short = simpleName(a.name);
    if (!(short in MAPPING)) continue;
    const paths = evalStrings(svc, cls, annArg(a, 'value', 'path', 'url'));
    let methods: HttpMethod[] = MAPPING[short] ? [MAPPING[short]!] : [];
    if (!MAPPING[short]) {
      const m = annArg(a, 'method');
      const items = m ? (m.kind === 'array' ? m.items : [m]) : [];
      methods = items
        .map(i => (i.kind === 'ref' ? i.name.slice(i.name.lastIndexOf('.') + 1) : i.kind === 'str' ? i.value : ''))
        .map(s => s.toUpperCase())
        .filter(s => HTTP_METHODS.has(s)) as HttpMethod[];
      if (!methods.length) methods = ['ANY'];
    }
    return { methods, paths: paths.length ? paths : [''] };
  }
  return undefined;
}

function classPrefixes(svc: ServiceModel, cls: ClassInfo): string[] {
  for (const c of [cls, ...ancestors(svc, cls)]) {
    const a = annotation(c.annotations, 'RequestMapping');
    if (a) {
      const p = evalStrings(svc, c, annArg(a, 'value', 'path'));
      if (p.length) return p;
    }
  }
  return [''];
}

function isController(cls: ClassInfo) {
  return cls.kind === 'class' && !!annotation(cls.annotations, 'RestController', 'Controller', 'RepositoryRestController');
}

function extractEndpoints(svc: ServiceModel, g: GraphBuilder): Endpoint[] {
  const out: Endpoint[] = [];
  for (const cls of svc.classes.filter(isController)) {
    const prefixes = classPrefixes(svc, cls);
    const supers = ancestors(svc, cls);
    const methodNames = new Set([...cls.methods, ...supers.flatMap(s => s.methods)].filter(m => !m.isConstructor).map(m => m.name));
    for (const name of methodNames) {
      const own = cls.methods.find(m => m.name === name);
      let mapping = own ? mappingOf(svc, cls, own.annotations) : undefined;
      let declCls = cls;
      let decl = own;
      if (!mapping) {
        for (const s of supers) {
          const sm = s.methods.find(m => m.name === name);
          const mm = sm && mappingOf(svc, s, sm.annotations);
          if (mm) {
            mapping = mm;
            declCls = s;
            decl = sm;
            break;
          }
        }
      }
      if (!mapping || !decl) continue;
      const handlerCls = own ? cls : declCls;
      const handler = g.methodNode(svc, handlerCls, name, (own ?? decl).line);
      for (const prefix of prefixes) {
        for (const p of mapping.paths) {
          for (const method of mapping.methods) {
            const fullPath = joinPaths(svc.contextPath, prefix, p);
            const id = `${svc.name}|${method} ${fullPath}`;
            if (out.some(e => e.id === id)) continue;
            const r = ref(svc, handlerCls.file, (own ?? decl).line);
            const ep: Endpoint = { id, service: svc.name, method, path: fullPath, className: handlerCls.fqn, methodName: name, handlerId: handler.id, ref: r };
            out.push(ep);
            g.node({ id: `ep:${id}`, kind: 'endpoint', label: `${method} ${fullPath}`, service: svc.name, endpointId: id, ref: r, className: handlerCls.fqn });
            g.edge(`ep:${id}`, handler.id, 'handles', 'high');
          }
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Per-method call analysis

const REPO_BASE = /^(Jpa|Crud|PagingAndSorting|ListCrud|ListPagingAndSorting|Mongo|ReactiveMongo|ReactiveCrud|R2dbc|Elasticsearch|Cassandra|Couchbase|Neo4j|Redis|KeyValue|QuerydslPredicateExecutor|JpaSpecificationExecutor|Revision)?Repository$|^Repository$/;
const READ_OP = /^(find|get|read|query|search|stream|count|exists|load|fetch)/;

function isRepository(svc: ServiceModel, cls: ClassInfo, seen = new Set<string>()): boolean {
  if (cls.kind !== 'interface' || seen.has(cls.fqn)) return false;
  seen.add(cls.fqn);
  return cls.extends.some(t => {
    const parent = resolveType(svc, cls, t);
    return parent ? isRepository(svc, parent, seen) : REPO_BASE.test(simpleName(t));
  }) || !!annotation(cls.annotations, 'RepositoryDefinition');
}

function entityOfRepository(svc: ServiceModel, cls: ClassInfo, seen = new Set<string>()): { table: string; entity?: ClassInfo } | undefined {
  if (seen.has(cls.fqn)) return undefined;
  seen.add(cls.fqn);
  const def = annotation(cls.annotations, 'RepositoryDefinition');
  const fromDef = def && annArg(def, 'domainClass');
  const entityType = fromDef?.kind === 'class' ? fromDef.name : Object.entries(cls.typeArgs).find(([k]) => /Repository|Executor/.test(k))?.[1]?.[0];
  if (entityType) {
    const entity = resolveType(svc, cls, entityType);
    return { table: entity ? tableName(svc, entity) : snake(simpleName(entityType)), entity };
  }
  for (const t of cls.extends) {
    const parent = resolveType(svc, cls, t);
    const r = parent && entityOfRepository(svc, parent, seen);
    if (r) return r;
  }
  return undefined;
}

function snake(s: string) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function tableName(svc: ServiceModel, entity: ClassInfo): string {
  const t = annotation(entity.annotations, 'Table');
  const d = annotation(entity.annotations, 'Document', 'Entity');
  const name = evalExpr(svc, entity, undefined, annArg(t, 'name', 'value')) ?? evalExpr(svc, entity, undefined, annArg(d, 'collection', 'value', 'name'));
  return name || snake(entity.name);
}

const SQL_TABLES = /\b(from|join|into|update|table)\s+([`"[]?[\w.]+[`"\]]?)/gi;

function sqlTables(sql: string): { table: string; write: boolean }[] {
  const write = /^\s*(insert|update|delete|merge|upsert|replace|create|drop|alter|truncate)\b/i.test(sql);
  const out = new Map<string, boolean>();
  for (const m of sql.matchAll(SQL_TABLES)) {
    const t = m[2].replace(/[`"[\]]/g, '');
    if (/^(select|set|where|dual)$/i.test(t)) continue;
    const isTarget = /into|update|table/i.test(m[1]);
    out.set(t, (out.get(t) ?? false) || (write && isTarget) || (write && /^\s*delete/i.test(sql)));
  }
  return [...out].map(([table, w]) => ({ table, write: w }));
}

const REST_TEMPLATE: Record<string, HttpMethod | 'EXCHANGE'> = {
  getForObject: 'GET', getForEntity: 'GET', headForHeaders: 'HEAD', postForObject: 'POST', postForEntity: 'POST', postForLocation: 'POST',
  put: 'PUT', patchForObject: 'PATCH', delete: 'DELETE', optionsForAllow: 'OPTIONS', exchange: 'EXCHANGE', execute: 'EXCHANGE'
};
const MESSAGING: Record<string, { broker: string; methods: RegExp }> = {
  KafkaTemplate: { broker: 'kafka', methods: /^(send|sendDefault)$/ },
  ReactiveKafkaProducerTemplate: { broker: 'kafka', methods: /^send$/ },
  KafkaProducer: { broker: 'kafka', methods: /^send$/ },
  Producer: { broker: 'kafka', methods: /^send$/ },
  StreamBridge: { broker: 'stream', methods: /^send$/ },
  JmsTemplate: { broker: 'jms', methods: /^(send|convertAndSend)$/ },
  JmsMessagingTemplate: { broker: 'jms', methods: /^(send|convertAndSend)$/ },
  RabbitTemplate: { broker: 'rabbit', methods: /^(send|convertAndSend|convertSendAndReceive)$/ },
  AmqpTemplate: { broker: 'rabbit', methods: /^(send|convertAndSend|convertSendAndReceive)$/ },
  RabbitMessagingTemplate: { broker: 'rabbit', methods: /^(send|convertAndSend)$/ },
  SqsTemplate: { broker: 'sqs', methods: /^(send|sendAsync|convertAndSend)$/ },
  QueueMessagingTemplate: { broker: 'sqs', methods: /^(send|convertAndSend)$/ },
  SnsTemplate: { broker: 'sns', methods: /^(send|convertAndSend|sendNotification)$/ },
  PubSubTemplate: { broker: 'pubsub', methods: /^publish$/ }
};
const JDBC = new Set(['JdbcTemplate', 'NamedParameterJdbcTemplate', 'JdbcClient', 'JdbcOperations', 'NamedParameterJdbcOperations', 'DatabaseClient']);

class MethodAnalyzer {
  private from: GraphNode;

  constructor(
    private svc: ServiceModel,
    private cls: ClassInfo,
    private m: MethodInfo,
    private g: GraphBuilder,
    private outbound: OutboundHttp[]
  ) {
    this.from = g.methodNode(svc, cls, m.name, m.line);
  }

  run() {
    if (this.m.isConstructor) return;
    for (const c of this.m.calls) this.call(c);
    for (const r of this.m.methodRefs) {
      const receiver = r.target === 'this' ? { kind: 'this' as const } : { kind: 'ident' as const, name: r.target };
      this.call({ receiver, segments: [{ name: r.name, args: [] }], line: r.line });
    }
  }

  private here(line: number) {
    return ref(this.svc, this.cls.file, line);
  }

  private receiverType(c: CallChain): string | undefined {
    const r = c.receiver;
    switch (r.kind) {
      case 'none':
      case 'this':
        return this.cls.fqn;
      case 'super':
        return this.cls.extends[0];
      case 'new':
        return r.type;
      case 'field':
        return findField(this.svc, this.cls, r.name)?.field.type;
      case 'ident': {
        if (this.m.locals[r.name]) {
          const t = this.m.locals[r.name];
          if (t === 'var' && this.m.localInits[r.name]?.kind === 'new') return (this.m.localInits[r.name] as { type: string }).type;
          return t;
        }
        const p = this.m.params.find(x => x.name === r.name);
        if (p) return p.type;
        const f = findField(this.svc, this.cls, r.name);
        if (f) return f.field.type;
        return /^[A-Z]/.test(r.name) ? r.name : undefined;
      }
      default:
        return undefined;
    }
  }

  private call(c: CallChain) {
    const first = c.segments[0];
    if (!first) return;
    const type = this.receiverType(c);
    const target = type === this.cls.fqn ? this.cls : resolveType(this.svc, this.cls, type);

    if (target) {
      if (isHttpInterface(target)) return this.httpInterfaceCall(target, first.name, c.line);
      if (isRepository(this.svc, target)) return this.repositoryCall(target, first.name, c.line);
      return this.internalCall(target, first.name, c.line);
    }

    const lib = type ? simpleName(type) : '';
    if (/RestTemplate$/.test(lib)) return this.restTemplate(c);
    if (/^(WebClient|RestClient)$/.test(lib) || (!type && c.segments.some(s => /^(retrieve|exchangeToMono|exchangeToFlux|exchange)$/.test(s.name)) && c.segments.some(s => s.name === 'uri'))) {
      return this.fluentHttp(c, lib || 'WebClient');
    }
    if (MESSAGING[lib] && MESSAGING[lib].methods.test(first.name)) return this.publish(MESSAGING[lib].broker, c);
    if (JDBC.has(lib)) return this.jdbc(c);
    if (lib === 'EntityManager') return this.entityManager(c);
    if (/^(MongoTemplate|ReactiveMongoTemplate|MongoOperations)$/.test(lib)) return this.mongoTemplate(c);
  }

  private internalCall(target: ClassInfo, name: string, line: number) {
    const owners = [target, ...ancestors(this.svc, target)];
    const isAbstract = target.kind === 'interface' || target.isAbstract;
    if (isAbstract) {
      const impls = this.svc.classes.filter(
        c => c.kind === 'class' && !c.isAbstract && c.fqn !== target.fqn && ancestors(this.svc, c).some(a => a.fqn === target.fqn) && hasMethod(this.svc, c, name)
      );
      if (impls.length) {
        for (const impl of impls) {
          const owner = [impl, ...ancestors(this.svc, impl)].find(o => o.methods.some(m => m.name === name && m.hasBody)) ?? impl;
          this.g.edge(this.from.id, this.g.methodNode(this.svc, owner, name).id, 'calls', impls.length === 1 ? 'high' : 'medium', undefined, this.here(line));
        }
        return;
      }
    }
    const owner = owners.find(o => o.methods.some(m => m.name === name));
    if (owner) this.g.edge(this.from.id, this.g.methodNode(this.svc, owner, name).id, 'calls', 'high', undefined, this.here(line));
  }

  private repositoryCall(repo: ClassInfo, name: string, line: number) {
    const entity = entityOfRepository(this.svc, repo);
    const table = entity?.table ?? snake(repo.name.replace(/Repository$/, ''));
    const decl = [repo, ...ancestors(this.svc, repo)].flatMap(c => c.methods).find(m => m.name === name);
    const query = decl && evalExpr(this.svc, repo, undefined, annArg(annotation(decl.annotations, 'Query'), 'value'));
    const modifying = decl && !!annotation(decl.annotations, 'Modifying');
    const write = query ? /^\s*(update|delete|insert)/i.test(query) || !!modifying : !READ_OP.test(name);
    const node = this.g.node({
      id: `repo:${this.svc.name}:${repo.fqn}#${name}`,
      kind: 'repository',
      label: `${repo.name}.${name}()`,
      service: this.svc.name,
      className: repo.fqn,
      detail: query ? `@Query: ${query}` : undefined,
      ref: ref(this.svc, repo.file, decl?.line ?? repo.line)
    });
    this.g.edge(this.from.id, node.id, 'calls', 'high', undefined, this.here(line));
    const t = this.tableNode(table, entity?.entity?.name);
    this.g.edge(node.id, t.id, write ? 'writes' : 'reads', 'high');
  }

  private tableNode(table: string, entity?: string) {
    return this.g.node({ id: `table:${this.svc.name}:${table.toLowerCase()}`, kind: 'table', label: table, service: this.svc.name, detail: entity ? `entity ${entity}` : undefined });
  }

  private httpInterfaceCall(iface: ClassInfo, name: string, line: number) {
    const feign = annotation(iface.annotations, 'FeignClient');
    const exchange = annotation(iface.annotations, 'HttpExchange');
    const decl = [iface, ...ancestors(this.svc, iface)].flatMap(c => c.methods.map(m => ({ c, m }))).find(x => x.m.name === name);
    if (!decl) return;
    const mapping = mappingOf(this.svc, decl.c, decl.m.annotations);
    if (!mapping) return;
    const service = feign ? evalExpr(this.svc, iface, undefined, annArg(feign, 'name', 'value', 'serviceId')) : undefined;
    const url = evalExpr(this.svc, iface, undefined, annArg(feign, 'url')) ?? evalExpr(this.svc, iface, undefined, annArg(exchange, 'url', 'value')) ?? '';
    const basePath = feign ? (evalExpr(this.svc, iface, undefined, annArg(feign, 'path')) ?? '') : '';
    const prefix = feign ? classPrefixes(this.svc, iface)[0] : '';
    for (const p of mapping.paths) {
      const full = `${url.replace(/\/$/, '')}${joinPaths(basePath, prefix, p)}`;
      this.outbound.push({
        from: this.from.id,
        service: this.svc,
        method: mapping.methods[0] ?? 'ANY',
        url: full,
        targetService: url ? undefined : service,
        via: feign ? `Feign ${iface.name}.${name}()` : `HTTP interface ${iface.name}.${name}()`,
        ref: this.here(line)
      });
    }
  }

  private restTemplate(c: CallChain) {
    const seg = c.segments[0];
    const kind = REST_TEMPLATE[seg.name];
    if (!kind) return;
    let method: HttpMethod = kind === 'EXCHANGE' ? 'ANY' : kind;
    if (kind === 'EXCHANGE') {
      const m = seg.args[1];
      const text = m?.kind === 'ref' ? m.name : '';
      const verb = text.slice(text.lastIndexOf('.') + 1).toUpperCase();
      if (HTTP_METHODS.has(verb)) method = verb as HttpMethod;
    }
    const url = this.eval(seg.args[0]) ?? DYN;
    this.outbound.push({ from: this.from.id, service: this.svc, method, url, via: `RestTemplate.${seg.name}`, ref: this.here(c.line) });
  }

  private fluentHttp(c: CallChain, client: string) {
    let method: HttpMethod = 'ANY';
    let uri: string | undefined;
    for (const s of c.segments) {
      const verb = s.name.toUpperCase();
      if (HTTP_METHODS.has(verb) && s.args.length === 0) method = verb as HttpMethod;
      if (s.name === 'method' && s.args[0]?.kind === 'ref') {
        const v = s.args[0].name.slice(s.args[0].name.lastIndexOf('.') + 1).toUpperCase();
        if (HTTP_METHODS.has(v)) method = v as HttpMethod;
      }
      if (s.name === 'uri' && s.args[0]) uri = this.eval(s.args[0]) ?? DYN;
    }
    const base = this.clientBaseUrl(c) ?? '';
    const url = uri === undefined ? `${base}` : /^[a-z]+:\/\//i.test(uri) ? uri : `${base.replace(/\/$/, '')}${uri.startsWith('/') || !base ? uri : `/${uri}`}`;
    this.outbound.push({ from: this.from.id, service: this.svc, method, url: url || DYN, via: `${client}.${method.toLowerCase()}()`, ref: this.here(c.line) });
  }

  // Base URL from where the client was built: field initializer / constructor assignment / local init,
  // e.g. builder.baseUrl("${x}").build(), WebClient.create(url), RestClient.create(url).
  private clientBaseUrl(c: CallChain): string | undefined {
    const r = c.receiver;
    let init: { expr: Expr; ctx: MethodInfo | undefined } | undefined;
    if (r.kind === 'ident' && this.m.localInits[r.name]) init = { expr: this.m.localInits[r.name], ctx: this.m };
    else if (r.kind === 'ident' || r.kind === 'field') {
      const f = findField(this.svc, this.cls, r.name);
      if (f?.field.initializer) init = { expr: f.field.initializer, ctx: undefined };
      else if (f) {
        for (const ctor of f.owner.methods.filter(m => m.isConstructor)) {
          const a = ctor.assignments.find(x => x.field === r.name);
          if (a) init = { expr: a.value, ctx: ctor };
        }
      }
    } else if (r.kind === 'none') {
      return undefined;
    }
    if (!init || init.expr.kind !== 'call') {
      const seg = c.segments.find(s => s.name === 'baseUrl' || s.name === 'create');
      return seg ? this.eval(seg.args[0]) : undefined;
    }
    for (const s of init.expr.chain.segments) {
      if ((s.name === 'baseUrl' || s.name === 'create' || s.name === 'rootUri') && s.args[0]) {
        return evalExpr(this.svc, this.cls, init.ctx, s.args[0]) ?? DYN;
      }
    }
    return undefined;
  }

  private publish(broker: string, c: CallChain) {
    const seg = c.segments[0];
    let destExpr = seg.args[0];
    if (destExpr?.kind === 'new' && /ProducerRecord|Message/.test(destExpr.type)) destExpr = destExpr.args[0];
    if (broker === 'rabbit' && seg.args.length >= 3) destExpr = seg.args[1];
    if (seg.name === 'sendDefault') {
      const dest = this.svc.props['spring.kafka.template.default-topic'];
      if (dest) return this.edgeToTopic(broker, dest, c.line);
    }
    const dest = this.eval(destExpr);
    if (dest) this.edgeToTopic(broker, broker === 'stream' ? this.streamDestination(dest) : dest, c.line);
  }

  private streamDestination(binding: string) {
    const p = this.svc.props;
    return p[`spring.cloud.stream.bindings.${binding}.destination`] ? resolvePlaceholders(p[`spring.cloud.stream.bindings.${binding}.destination`], p) : binding;
  }

  private edgeToTopic(broker: string, dest: string, line: number) {
    const t = this.g.topicNode(broker, dest);
    this.g.edge(this.from.id, t.id, 'publishes', dest.includes(DYN) ? 'low' : 'high', undefined, this.here(line));
  }

  private jdbc(c: CallChain) {
    const seg = c.segments.find(s => s.name === 'sql') ?? c.segments[0];
    const sql = this.eval(seg.args[0]);
    if (!sql) return;
    for (const t of sqlTables(sql)) {
      this.g.edge(this.from.id, this.tableNode(t.table).id, t.write ? 'writes' : 'reads', 'high', undefined, this.here(c.line));
    }
  }

  private entityManager(c: CallChain) {
    const seg = c.segments[0];
    if (/^(createQuery|createNativeQuery)$/.test(seg.name)) {
      const sql = this.eval(seg.args[0]);
      if (sql) for (const t of sqlTables(sql)) this.g.edge(this.from.id, this.tableNode(this.entityTable(t.table)).id, t.write ? 'writes' : 'reads', 'medium', undefined, this.here(c.line));
      return;
    }
    const cls = seg.args.find(a => a.kind === 'class');
    if (cls?.kind === 'class') {
      const entity = resolveType(this.svc, this.cls, cls.name);
      this.g.edge(this.from.id, this.tableNode(entity ? tableName(this.svc, entity) : snake(cls.name), entity?.name).id, /^(find|getReference)$/.test(seg.name) ? 'reads' : 'writes', 'medium', undefined, this.here(c.line));
    }
  }

  private entityTable(name: string) {
    const entity = this.svc.bySimple.get(name)?.[0];
    return entity ? tableName(this.svc, entity) : name;
  }

  private mongoTemplate(c: CallChain) {
    const seg = c.segments[0];
    const cls = seg.args.find(a => a.kind === 'class');
    const coll = seg.args.length > 1 ? this.eval(seg.args[seg.args.length - 1]) : undefined;
    let name = coll && !coll.includes(DYN) ? coll : undefined;
    let entityName: string | undefined;
    if (!name && cls?.kind === 'class') {
      const entity = resolveType(this.svc, this.cls, cls.name);
      name = entity ? tableName(this.svc, entity) : snake(cls.name);
      entityName = entity?.name;
    }
    if (name) this.g.edge(this.from.id, this.tableNode(name, entityName).id, READ_OP.test(seg.name) ? 'reads' : 'writes', 'medium', undefined, this.here(c.line));
  }

  private eval(e: Expr | undefined) {
    return evalExpr(this.svc, this.cls, this.m, e);
  }
}

function hasMethod(svc: ServiceModel, cls: ClassInfo, name: string) {
  return [cls, ...ancestors(svc, cls)].some(c => c.methods.some(m => m.name === name && m.hasBody));
}

function isHttpInterface(cls: ClassInfo) {
  return cls.kind === 'interface' && !!annotation(cls.annotations, 'FeignClient', 'HttpExchange');
}

function listenerTopics(svc: ServiceModel, cls: ClassInfo, m: MethodInfo): { broker: string; dest: string }[] {
  const out: { broker: string; dest: string }[] = [];
  const add = (broker: string, a: Annotation | undefined, ...keys: string[]) => {
    if (!a) return;
    for (const k of keys) for (const d of evalStrings(svc, cls, a.args[k])) out.push({ broker, dest: d });
  };
  const kafka = annotation(m.annotations, 'KafkaListener') ?? (annotation(m.annotations, 'KafkaHandler') ? annotation(cls.annotations, 'KafkaListener') : undefined);
  add('kafka', kafka, 'topics', 'value', 'topicPattern');
  add('jms', annotation(m.annotations, 'JmsListener'), 'destination');
  add('rabbit', annotation(m.annotations, 'RabbitListener') ?? (annotation(m.annotations, 'RabbitHandler') ? annotation(cls.annotations, 'RabbitListener') : undefined), 'queues', 'value');
  add('sqs', annotation(m.annotations, 'SqsListener'), 'value', 'queueNames');
  const stream = annotation(m.annotations, 'StreamListener');
  if (stream) for (const b of evalStrings(svc, cls, annArg(stream, 'value', 'target'))) out.push({ broker: 'stream', dest: svc.props[`spring.cloud.stream.bindings.${b}.destination`] ?? b });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Cross-service linking

function splitUrl(url: string): { host?: string; path: string } {
  const u = url.trim();
  const m = u.match(/^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/:?#]+)(?::[^/]*)?(\/.*)?$/i);
  if (m) return { host: m[1], path: (m[2] ?? '/').split(/[?#]/)[0] };
  const dyn = u.match(/^(?:\{\*\}|\$\{[^}]+\})+(.*)$/);
  if (dyn) return { path: (dyn[1] || '/').split(/[?#]/)[0] };
  return { path: u.split(/[?#]/)[0] };
}

function segments(p: string) {
  return normalizePath(p).split('/').filter(Boolean);
}

// Returns a score (higher = more literal segments matched) or -1 when the paths don't match.
export function matchPath(template: string, actual: string): number {
  const t = segments(template);
  const a = segments(actual);
  const dynTail = a.length && a[a.length - 1] === DYN;
  if (t.length !== a.length && !(dynTail && t.length >= a.length - 1)) return -1;
  let score = 0;
  for (let i = 0; i < Math.min(t.length, a.length); i++) {
    const ts = t[i];
    const as = a[i];
    if (ts.includes('{') || as.includes('{') || as.includes('${')) continue;
    if (ts !== as) return -1;
    score++;
  }
  return score;
}

function findService(services: ServiceModel[], name: string | undefined): ServiceModel | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  return services.find(s => s.aliases.has(n)) ?? services.find(s => [...s.aliases].some(a => n.startsWith(`${a}.`) || n === `${a}-svc` || n === `${a}-service`));
}

function linkHttp(calls: OutboundHttp[], services: ServiceModel[], endpoints: Endpoint[], g: GraphBuilder) {
  for (const c of calls) {
    const { host, path: rawPath } = splitUrl(c.url);
    const svcName = c.targetService ?? host;
    const target = findService(services, svcName);
    const p = normalizePath(rawPath) || '/';
    const label = `${c.method} ${p}`;
    if (svcName && !target && host && !/\$\{|\{\*\}/.test(host)) {
      const ext = g.node({ id: `ext:${host}`, kind: 'external', label: host, detail: 'External system (not in scanned repos)' });
      g.edge(c.from, ext.id, 'http', 'high', `${label} via ${c.via}`, c.ref);
      continue;
    }
    const candidates = endpoints.filter(e => (!target || e.service === target.name) && (c.method === 'ANY' || e.method === 'ANY' || e.method === c.method));
    let best: Endpoint | undefined;
    let bestScore = -1;
    for (const e of candidates) {
      const s = matchPath(e.path, p);
      if (s > bestScore || (s === bestScore && s >= 0 && best && e.method === c.method && best.method !== c.method)) {
        best = e;
        bestScore = s;
      }
    }
    const confidence: Confidence = target ? 'high' : bestScore >= 2 ? 'medium' : 'low';
    if (best && bestScore >= 0 && (target || bestScore >= 1)) {
      g.edge(c.from, `ep:${best.id}`, 'http', confidence, `${label} via ${c.via}`, c.ref);
    } else {
      const who = target?.name ?? svcName ?? 'unknown service';
      const u = g.node({ id: `unresolved:${who}:${label}`, kind: 'unresolved', label: `${c.method} ${who}${p}`, service: target?.name, detail: `No matching endpoint found for ${c.url}` });
      g.edge(c.from, u.id, 'http', 'low', `${label} via ${c.via}`, c.ref);
    }
  }
}

interface Route {
  id: string;
  uri: string;
  paths: string[];
  stripPrefix: number;
  prefixPath?: string;
  rewrite?: { regex: string; replacement: string };
  ref: SourceRef;
}

function gatewayRoutes(svc: ServiceModel): Route[] {
  const routes: Route[] = [];
  const cfgRef: SourceRef = { service: svc.name, file: path.join(svc.moduleDir, 'src/main/resources'), line: 1 };
  for (const prefix of ['spring.cloud.gateway.routes', 'spring.cloud.gateway.server.webflux.routes', 'spring.cloud.gateway.mvc.routes', 'spring.cloud.gateway.server.webmvc.routes']) {
    for (const r of listIndexed(svc.props, prefix)) {
      const route: Route = { id: r.id ?? `route${routes.length}`, uri: resolvePlaceholders(r.uri ?? '', svc.props), paths: [], stripPrefix: 0, ref: cfgRef };
      for (const [k, v0] of Object.entries(r)) {
        const v = resolvePlaceholders(v0, svc.props);
        if (/^predicates\[\d+\]$/.test(k)) {
          const m = v.match(/^Path\s*=\s*(.*)$/);
          if (m) route.paths.push(...m[1].split(',').map(s => s.trim()));
        } else if (/^predicates\[\d+\]\.args\..*/.test(k) && r[k.replace(/\.args\..*$/, '.name')] === 'Path') {
          route.paths.push(...v.split(',').map(s => s.trim()));
        } else if (/^filters\[\d+\]$/.test(k)) {
          applyFilter(route, v);
        } else if (/^filters\[\d+\]\.name$/.test(k)) {
          const args = Object.entries(r).filter(([kk]) => kk.startsWith(k.replace(/\.name$/, '.args.'))).map(([, vv]) => vv);
          applyFilter(route, `${v}=${args.join(',')}`);
        }
      }
      routes.push(route);
    }
  }
  for (const r of listIndexed(svc.props, 'zuul.routes').length ? [] : zuulRoutes(svc)) routes.push(r);
  for (const cls of svc.classes) routes.push(...javaDslRoutes(svc, cls));
  return routes.filter(r => r.paths.length && r.uri);
}

function zuulRoutes(svc: ServiceModel): Route[] {
  const byName = new Map<string, Record<string, string>>();
  for (const [k, v] of Object.entries(svc.props)) {
    const m = k.match(/^zuul\.routes\.([^.]+)\.(path|serviceId|service-id|url|stripPrefix|strip-prefix)$/);
    if (m) byName.set(m[1], { ...(byName.get(m[1]) ?? {}), [m[2]]: v });
  }
  return [...byName].map(([id, r]) => {
    const p = r.path ?? `/${id}/**`;
    const strip = (r.stripPrefix ?? r['strip-prefix']) !== 'false';
    return {
      id,
      uri: r.url ?? `lb://${r.serviceId ?? r['service-id'] ?? id}`,
      paths: [p],
      stripPrefix: strip ? segments(p.replace(/\/\*\*$/, '')).length : 0,
      ref: { service: svc.name, file: path.join(svc.moduleDir, 'src/main/resources'), line: 1 }
    };
  });
}

function javaDslRoutes(svc: ServiceModel, cls: ClassInfo): Route[] {
  const out: Route[] = [];
  for (const m of cls.methods) {
    if (!m.params.some(p => /RouteLocatorBuilder/.test(p.type))) continue;
    let text: string;
    try {
      text = readFileSync(path.join(svc.repo.dir, cls.file), 'utf8');
    } catch {
      continue;
    }
    const re = /\.route\(\s*"([^"]+)"([\s\S]*?)\.uri\(\s*"([^"]+)"\s*\)/g;
    for (const r of text.matchAll(re)) {
      const body = r[2];
      const paths = [...body.matchAll(/\.path\(([^)]*)\)/g)].flatMap(x => [...x[1].matchAll(/"([^"]+)"/g)].map(y => y[1]));
      const strip = body.match(/stripPrefix\(\s*(\d+)\s*\)/);
      const rewrite = body.match(/rewritePath\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/);
      const prefix = body.match(/prefixPath\(\s*"([^"]+)"\s*\)/);
      out.push({
        id: r[1],
        uri: resolvePlaceholders(r[3], svc.props),
        paths,
        stripPrefix: strip ? Number(strip[1]) : 0,
        prefixPath: prefix?.[1],
        rewrite: rewrite ? { regex: rewrite[1].replace(/\\\\/g, '\\'), replacement: rewrite[2] } : undefined,
        ref: ref(svc, cls.file, m.line)
      });
    }
  }
  return out;
}

function applyFilter(route: Route, f: string) {
  const [name, ...rest] = f.split('=');
  const args = rest.join('=');
  if (name.trim() === 'StripPrefix') route.stripPrefix = Number(args) || 1;
  if (name.trim() === 'PrefixPath') route.prefixPath = args.trim();
  if (name.trim() === 'RewritePath') {
    const idx = args.indexOf(',');
    if (idx > 0) route.rewrite = { regex: args.slice(0, idx).trim(), replacement: args.slice(idx + 1).trim() };
  }
}

const REST = 'XXRESTXX';

export function routeInternalPattern(route: Pick<Route, 'stripPrefix' | 'prefixPath' | 'rewrite'>, external: string): string {
  let p = external.replace(/\/\*\*$/, `/${REST}`);
  if (route.stripPrefix) p = `/${p.split('/').filter(Boolean).slice(route.stripPrefix).join('/')}`;
  if (route.prefixPath) p = `${route.prefixPath.replace(/\/$/, '')}${p}`;
  if (route.rewrite) {
    try {
      const replacement = route.rewrite.replacement.replace(/\$\\?\{(\w+)\}/g, '$<$1>');
      p = p.replace(new RegExp(route.rewrite.regex), replacement);
    } catch {
      // invalid/unsupported regex: keep the path unchanged
    }
  }
  return p.replace(REST, '**');
}

function globToRegex(glob: string): RegExp {
  const re = glob
    .split('/')
    .map(s => (s === '**' ? '.*' : s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+').replace(/\*/g, '[^/]*')))
    .join('/');
  return new RegExp(`^${re.replace(/\/\.\*$/, '(/.*)?')}$`);
}

function linkGateways(services: ServiceModel[], endpoints: Endpoint[], g: GraphBuilder, warnings: string[]) {
  for (const svc of services) {
    for (const route of gatewayRoutes(svc)) {
      const host = splitUrl(route.uri).host;
      const target = findService(services, host);
      if (!target) {
        warnings.push(`${svc.name}: gateway route "${route.id}" targets ${route.uri}, which is not in the scanned repos`);
        continue;
      }
      const node = g.node({
        id: `gw:${svc.name}:${route.id}`,
        kind: 'gateway',
        label: `${svc.name} ${route.paths.join(', ')}`,
        service: svc.name,
        detail: `Route "${route.id}" → ${route.uri}`,
        ref: route.ref
      });
      for (const ext of route.paths) {
        const re = globToRegex(routeInternalPattern(route, ext));
        for (const e of endpoints.filter(x => x.service === target.name && re.test(x.path))) {
          g.edge(node.id, `ep:${e.id}`, 'routes', 'high', ext);
        }
      }
    }
  }
}
