import test from "node:test";
import assert from "node:assert/strict";
import { expressMounts, joinPath, recoverExpressRoutes, recoverGinRoutes } from "../src/crossrepo/route-table.ts";

// Every shape below is copied from the real target's registration source, not invented: a group chain with
// middleware arguments, a nested group, an empty local path, a catch-all, and express's factory-router
// form. A recovered path that is right on a shape nobody writes is worth nothing.

const GIN = [
  "func Register(engine *gin.Engine, e *Env) {",                          // 1
  "\tv2 := engine.Group(\"/v2\")",                                        // 2
  "\tv2ApiDoc := v2.Group(\"/swagger\")",                                 // 3
  "\tv2ApiDoc.GET(\"/*any\", ginSwagger.WrapHandler(swaggerFiles.Handler))", // 4
  "\tsupGrp := v2.Group(\"/support\", auth.Authentication())",            // 5
  "\t{",                                                                   // 6
  "\t\tsupPosGrp := supGrp.Group(\"/positions\")",                        // 7
  "\t\t{",                                                                 // 8
  "\t\t\tsupPosGrp.GET(\"\", e.CatchError(support.Positions))",           // 9
  "\t\t\tsupPosGrp.GET(\"/:position_id\", e.CatchError(support.Position))", // 10
  "\t\t}",                                                                 // 11
  "\t}",                                                                   // 12
  "\tleaveGrp := v2.Group(\"/leaves\")",                                  // 13
  "\tleaveGrp.POST(\"\", e.CatchError(leave.Creation))",                  // 14
  "}",                                                                     // 15
].join("\n");

test("a gin route carries its whole group chain, not the path written at the call", () => {
  const recovery = recoverGinRoutes("internal/handlers/handlers.go", GIN);
  const paths = recovery.routes.map((route) => `${route.method} ${route.path}`);
  assert.ok(paths.includes("POST /v2/leaves"), `expected the group prefix to be recovered, got ${JSON.stringify(paths)}`);
  assert.ok(paths.includes("GET /v2/support/positions"), "an empty local path resolves to the group itself");
  assert.ok(paths.includes("GET /v2/support/positions/:position_id"), "two levels of nesting");
  assert.deepEqual(recovery.unrecovered, []);
});

test("the middleware argument on a group changes who may call it, never the path", () => {
  const recovery = recoverGinRoutes("h.go", GIN);
  const positions = recovery.routes.find((route) => route.path === "/v2/support/positions" && route.method === "GET");
  assert.ok(positions, "a group declared with middleware still contributes its prefix");
});

test("the handler expression is kept verbatim, because that is what resolves to a function", () => {
  const recovery = recoverGinRoutes("h.go", GIN);
  const creation = recovery.routes.find((route) => route.path === "/v2/leaves" && route.method === "POST");
  assert.equal(creation?.handlerExpression, "e.CatchError(leave.Creation)");
  assert.equal(creation?.localPath, "", "the path as written stays visible next to the recovered one");
  assert.equal(creation?.line, 14);
});

test("a non-literal path is recorded as unrecovered rather than guessed", () => {
  const source = [
    "func Register(engine *gin.Engine) {",
    "\tv2 := engine.Group(\"/v2\")",
    "\tv2.GET(prefix+\"/dynamic\", handler)",
    "}",
  ].join("\n");
  const recovery = recoverGinRoutes("h.go", source);
  assert.deepEqual(recovery.routes, []);
  assert.equal(recovery.unrecovered.length, 1);
  assert.match(recovery.unrecovered[0].reason, /not a string literal/);
});

test("a registration on an unknown router variable is unrecovered, not silently rooted", () => {
  const source = ["func f() {", "\tmystery.GET(\"/thing\", handler)", "}"].join("\n");
  const recovery = recoverGinRoutes("h.go", source);
  assert.deepEqual(recovery.routes, []);
  assert.match(recovery.unrecovered[0]?.reason ?? "", /no resolved prefix/);
});

test("express mounts are read from app.use, and inline middleware is not a mount", () => {
  const app = [
    "app.use(cors());",
    "app.use(express.static(path.join(__dirname, 'public')));",
    "app.use('/public', express.static('public'));",
    "app.use('/leaves', leaveRouter);",
    "app.use('/v2/worklogs', worklogRouterV2);",
  ].join("\n");
  const mounts = expressMounts(app);
  assert.deepEqual(mounts.map((mount) => `${mount.prefix}→${mount.identifier}`), ["/leaves→leaveRouter", "/v2/worklogs→worklogRouterV2"]);
});

test("an express router file inherits its mount prefix", () => {
  const source = [
    "module.exports = (passport) => {",
    "  router.post('/', validate([]), leaveController.create);",
    "  router.get('/leave/types', passport.authenticate('jwt'), leaveController.types);",
    "  router.put('/cancel', leaveController.cancel);",
    "  return router;",
    "};",
  ].join("\n");
  const recovery = recoverExpressRoutes("routes/leave.js", source, "/leaves");
  assert.deepEqual(recovery.routes.map((route) => `${route.method} ${route.path}`).sort(), [
    "GET /leaves/leave/types",
    "POST /leaves",
    "PUT /leaves/cancel",
  ]);
});

test("path joining matches how a router composes, including the empty-suffix case", () => {
  assert.equal(joinPath("/v2/leaves", ""), "/v2/leaves");
  assert.equal(joinPath("/v2", "/leaves"), "/v2/leaves");
  assert.equal(joinPath("/v2/", "/leaves/"), "/v2/leaves");
  assert.equal(joinPath("", "/leaves"), "/leaves");
});

test("recovery is byte-stable: the same source yields the same table twice", () => {
  const a = recoverGinRoutes("h.go", GIN);
  const b = recoverGinRoutes("h.go", GIN);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
