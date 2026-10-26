# API Traceability for Java / Spring microservices

A web app that scans the Java/Spring Boot microservices in a Bitbucket workspace or project and lists every REST
endpoint. For each endpoint it shows the full **end-to-end chain** in both directions:

- **Upstream:** who calls it. This covers Spring Cloud Gateway / Zuul routes, other services' Feign / RestTemplate /
  WebClient / RestClient calls, and asynchronous producers whose Kafka/JMS/Rabbit/SQS messages lead to it. The chain
  continues back to the entry points.
- **Downstream:** what it depends on. That's controller → service → repository → **DB table** (JPA, Mongo,
  JdbcTemplate SQL), plus outgoing HTTP calls to other services' endpoints (followed into those services),
  messages published to topics and their consumers, and **external systems** such as `api.stripe.com`.

The graph can be shown at **service**, **class** or **method** level. The chains view lists every path, each node
links to the exact source line in Bitbucket, and the whole scan can be exported as CSV.

## Quick start

```bash
npm install
npm run dev          # API on :4000, UI on http://localhost:5173
# or
npm run build && npm start   # single server on http://localhost:4000
```

On first start the app scans `samples/microservices` (a gateway plus five services that use Feign, RestTemplate,
WebClient, RestClient, Kafka, JPA, Mongo and JdbcTemplate) so there is something to explore straight away.

Docker:

```bash
docker build -t api-traceability .
docker run -p 4000:4000 -v trace-data:/data -e BITBUCKET_TOKEN=... api-traceability
```

## Scanning Bitbucket

Click **New scan** and choose one of:

| Source | Required | Notes |
|---|---|---|
| Bitbucket Cloud | workspace | Optionally a project key, repo list, repo regex and branch (defaults to each repo's main branch). |
| Bitbucket Data Center / Server | base URL, project key | Uses `/rest/api/1.0/projects/{key}/repos`. |
| Local folders | paths under `LOCAL_SCAN_ROOTS` | For repos that are already cloned. |

Credentials need **read access to repositories**:
- Bitbucket Cloud: a workspace, project or repository access token, or a username plus an app password / API token.
- Data Center: an HTTP access token, or a username and password.

Credentials typed into the form are used only for that scan and are never written to disk. You can also set
`BITBUCKET_TOKEN`, or `BITBUCKET_USERNAME` + `BITBUCKET_APP_PASSWORD`, on the server. Repos are shallow-cloned into
`DATA_DIR/repos`. The token is passed to git as an `http.extraHeader` through environment variables, so it never
appears in the clone URL, the process list or `.git/config`.

CLI (handy in CI):

```bash
npm run analyze -- --workspace acme --project PAY --out result.json
npm run analyze -- --base-url https://bitbucket.acme.com --project PAY
npm run analyze -- --local ../checkouts --endpoint "order-service|POST /api/orders"
```

## How it works

```
Bitbucket API ──list repos──► shallow clone ──► find modules (any dir with src/main)
  └► per module: application*.yml/properties (+ profiles, relaxed binding, ${…:default})
  └► tree-sitter Java parser ──► classes, fields, ctor params, annotations, call chains, constants
       └► endpoints   @RestController/@Controller + @Get/Post/…/RequestMapping (class prefix, constants,
                      arrays, inherited interface mappings, server.servlet.context-path)
       └► call graph  receiver type from fields / ctor injection / Lombok / locals / params;
                      interface → implementation(s); abstract/super classes
       └► leaves      Spring Data repos → entity → @Table/@Document; JdbcTemplate/JdbcClient/EntityManager/MongoTemplate SQL
       └► outbound    Feign (@FeignClient name/url/path), @HttpExchange, RestTemplate, WebClient, RestClient
                      (URL resolved from literals, constants, @Value, constructor-built baseUrl, String.format)
       └► messaging   KafkaTemplate, StreamBridge, JmsTemplate, RabbitTemplate, SqsTemplate… and their @…Listener methods
  └► linker  HTTP calls → endpoint (service by spring.application.name / artifactId / host; path template match)
             unknown host → external system; no match → "unresolved" node
             gateway routes (YAML, Java RouteLocator DSL, Zuul) with StripPrefix / PrefixPath / RewritePath
  └► graph   trace = BFS downstream (out-edges) and upstream (in-edges) from the endpoint
```

### Limitations

This is static analysis, so some things can't be seen:
- URLs built at runtime (from databases or service discovery metadata) show up as `unresolved` or low-confidence edges.
- Reflection and AOP aren't followed.
- WebFlux functional `RouterFunction` routes aren't extracted yet.
- Callers outside the scanned repos (front-ends, partners) can't be discovered. An endpoint with no upstream is an
  entry point as far as the scanned code is concerned.

Each edge carries a `confidence` (low-confidence edges are drawn dashed). The scan's warnings list config problems,
such as gateway routes that point to services that weren't scanned.

## Configuration

See `.env.example`: `PORT`, `DATA_DIR`, `BITBUCKET_*`, `LOCAL_SCAN_ROOTS`, `DEMO_SCAN`.

The app has no built-in user authentication. Deploy it behind your SSO / reverse proxy.

## Development

```bash
npm run typecheck && npm test && npm run build
```

- `server/src/analyzer`: parser, config, analysis, trace
- `server/src/sources`: Bitbucket and local sources
- `web/src`: React + React Flow UI
- `test/analyzer.test.ts`: tests against the sample services
