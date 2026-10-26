import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeRepos, matchPath, normalizePath, routeInternalPattern } from '../server/src/analyzer/analyze';
import { parseProperties, parseYaml, resolvePlaceholders } from '../server/src/analyzer/config';
import { computeTrace, serviceMap } from '../server/src/analyzer/trace';
import type { ScanResult } from '../server/src/analyzer/types';

const SAMPLES = path.resolve(__dirname, '../samples/microservices');
let r: ScanResult;
const has = (src: string, tgt: string, kind: string) => r.edges.some(e => e.source.includes(src) && e.target.includes(tgt) && e.kind === kind);

beforeAll(async () => {
  r = await analyzeRepos([{ repo: 'samples', dir: SAMPLES, webUrl: (f, l) => `https://bitbucket.org/acme/samples/src/main/${f}#lines-${l}` }]);
});

describe('endpoint extraction', () => {
  it('finds every Spring MVC endpoint with class-level prefixes and constants', () => {
    const ids = r.endpoints.map(e => e.id).sort();
    expect(ids).toEqual([
      'customer-service|GET /api/customers/{id}/verification',
      'inventory-service|DELETE /api/inventory/reservations/{orderId}',
      'inventory-service|GET /api/inventory/{sku}',
      'inventory-service|POST /api/inventory/{sku}/reserve',
      'order-service|GET /api/orders',
      'order-service|GET /api/orders/{id}',
      'order-service|POST /api/orders',
      'order-service|POST /api/orders/{id}/cancel',
      'payment-service|GET /api/payments/{paymentId}',
      'payment-service|POST /api/payments'
    ]);
  });

  it('links endpoints to source with Bitbucket URLs', () => {
    const ep = r.endpoints.find(e => e.id === 'order-service|POST /api/orders')!;
    expect(ep.ref.file).toBe('order-service/src/main/java/com/acme/orders/api/OrderController.java');
    expect(ep.ref.url).toMatch(/OrderController\.java#lines-\d+$/);
  });
});

describe('call graph', () => {
  it('resolves interface calls to the implementation (constructor + Lombok + field injection)', () => {
    expect(has('OrderController#create', 'OrderServiceImpl#placeOrder', 'calls')).toBe(true);
    expect(has('InventoryController#reserve', 'InventoryService#reserve', 'calls')).toBe(true);
  });

  it('maps Spring Data repositories to tables with read/write', () => {
    expect(has('OrderRepository#findByCustomerId', 'table:order-service:orders', 'reads')).toBe(true);
    expect(has('OrderRepository#markCancelled', 'table:order-service:orders', 'writes')).toBe(true);
    expect(has('ReservationRepository#save', 'table:inventory-service:reservation', 'writes')).toBe(true);
    expect(has('CustomerRepository#existsById', 'table:customer-service:customers', 'reads')).toBe(true);
  });

  it('extracts tables from JdbcTemplate SQL', () => {
    expect(has('PaymentLedger#record', 'table:payment-service:payments', 'writes')).toBe(true);
    expect(has('PaymentLedger#find', 'table:payment-service:payments', 'reads')).toBe(true);
  });
});

describe('cross-service links', () => {
  it('Feign client -> target endpoint', () => {
    expect(has('OrderServiceImpl#placeOrder', 'ep:inventory-service|POST /api/inventory/{sku}/reserve', 'http')).toBe(true);
    expect(has('OrderServiceImpl#cancel', 'ep:inventory-service|DELETE /api/inventory/reservations/{orderId}', 'http')).toBe(true);
  });

  it('RestTemplate with @Value base URL and HttpMethod', () => {
    expect(has('PaymentClient#charge', 'ep:payment-service|POST /api/payments', 'http')).toBe(true);
    expect(has('PaymentClient#status', 'ep:payment-service|GET /api/payments/{paymentId}', 'http')).toBe(true);
  });

  it('WebClient/RestClient with baseUrl from constructor or factory', () => {
    expect(has('CustomerClient#verify', 'ep:customer-service|GET /api/customers/{id}/verification', 'http')).toBe(true);
    expect(has('NotificationService#notifyCustomer', 'ep:customer-service|GET /api/customers/{id}/verification', 'http')).toBe(true);
  });

  it('external systems and Kafka topics', () => {
    expect(has('PaymentProcessor#charge', 'ext:api.stripe.com', 'http')).toBe(true);
    expect(has('OrderEventPublisher#orderPlaced', 'topic:order-events', 'publishes')).toBe(true);
    expect(has('topic:order-events', 'OrderEventsListener#onOrderEvent', 'consumes')).toBe(true);
  });

  it('gateway routes with StripPrefix and RewritePath', () => {
    expect(has('gw:api-gateway:orders', 'ep:order-service|POST /api/orders', 'routes')).toBe(true);
    expect(has('gw:api-gateway:inventory', 'ep:inventory-service|GET /api/inventory/{sku}', 'routes')).toBe(true);
    expect(r.edges.some(e => e.source.startsWith('gw:') && e.target.includes('payment-service'))).toBe(false);
  });
});

describe('trace', () => {
  it('downstream of POST /api/orders spans services, tables, topics and externals', () => {
    const t = computeTrace(r, 'order-service|POST /api/orders', 'class')!;
    expect(t.stats.upstreamServices).toEqual(['api-gateway']);
    expect(t.stats.downstreamServices.sort()).toEqual(['customer-service', 'inventory-service', 'notification-service', 'payment-service']);
    expect(t.stats.topics).toEqual(['order-events']);
    expect(t.stats.externals).toEqual(['api.stripe.com']);
    expect(t.stats.tables).toContain('inventory-service.stock_items');
    const labels = t.chains.filter(c => c.direction === 'downstream').map(c => c.steps.map(s => s.label).join(' > '));
    expect(labels).toContain('POST /api/orders > OrderController > OrderServiceImpl > OrderEventPublisher > order-events > OrderEventsListener > NotificationService > GET /api/customers/{id}/verification > CustomerController > CustomerRepository > customers');
  });

  it('upstream of customer verification includes sync and async callers back to the gateway', () => {
    const t = computeTrace(r, 'customer-service|GET /api/customers/{id}/verification', 'service')!;
    expect(t.stats.upstreamServices.sort()).toEqual(['api-gateway', 'notification-service', 'order-service']);
    const up = t.chains.filter(c => c.direction === 'upstream').map(c => c.steps.map(s => s.label).join(' > '));
    expect(up).toContain('api-gateway > order-service > order-events > notification-service > GET /api/customers/{id}/verification');
    expect(up).toContain('api-gateway > order-service > GET /api/customers/{id}/verification');
    expect(t.nodes.find(n => n.id === 'svc:notification-service')?.side).toBe('upstream');
  });

  it('service map aggregates inter-service edges', () => {
    const m = serviceMap(r);
    expect(m.edges.some(e => e.source === 'svc:order-service' && e.target === 'svc:inventory-service' && e.kind === 'http')).toBe(true);
    expect(m.edges.some(e => e.source === 'topic:order-events' && e.target === 'svc:notification-service')).toBe(true);
  });
});

describe('helpers', () => {
  it('path matching and normalisation', () => {
    expect(normalizePath('/api//orders/{id:\\d+}/')).toBe('/api/orders/{id}');
    expect(matchPath('/api/orders/{id}', '/api/orders/{*}')).toBe(2);
    expect(matchPath('/api/orders/{id}', '/api/customers/1')).toBe(-1);
  });

  it('gateway filter transforms', () => {
    expect(routeInternalPattern({ stripPrefix: 1 }, '/public/api/orders/**')).toBe('/api/orders/**');
    expect(routeInternalPattern({ stripPrefix: 0, rewrite: { regex: '/public/inventory/(?<segment>.*)', replacement: '/api/inventory/${segment}' } }, '/public/inventory/**')).toBe('/api/inventory/**');
    expect(routeInternalPattern({ stripPrefix: 0, prefixPath: '/v2' }, '/x/**')).toBe('/v2/x/**');
  });

  it('config parsing, relaxed binding and placeholders', () => {
    const props = { ...parseYaml('clients:\n  customer:\n    baseUrl: http://c\n'), ...parseProperties('a.b=${clients.customer.base-url}/x\nc=${missing:dflt}') };
    expect(resolvePlaceholders('${a.b}', props)).toBe('http://c/x');
    expect(resolvePlaceholders('${c}', props)).toBe('dflt');
    expect(resolvePlaceholders('${nope}/y', props)).toBe('${nope}/y');
  });
});
