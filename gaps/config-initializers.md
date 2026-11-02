---
code: COVERAGE
status: supported
example: tests/fixtures/rails-graphql config/initializers/rack_attack.rb:3
---
The index reads app/ and lib/ only, so request-wide decisions in config/initializers (rate limits, CORS, middleware) never appear. The login flow's missing rate limit went unseen: the throttle matches /v1/login, which no route serves.

Support: the index reads config/initializers and config/routes.rb. Each initializer that sets up Rack middleware becomes a whole-file unit (`init:<file>`), the first step of every HTTP and GraphQL entry point; its prompt lists the app's routes, so a rule that matches no route gets a note. Other initializers are startup settings and get that reason when a change touches them. Guarded by "config initializers: …" in tests/framework.test.mjs and the rack-attack-dead-route eval.
