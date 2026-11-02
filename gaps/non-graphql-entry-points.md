---
code: UNSUPPORTED_CODEBASE
status: supported
example: tests/fixtures/rails-graphql app/controllers/admin/payments_controller.rb:6
---
Entry points are GraphQL mutations, queries and jobs. REST controller actions (routes), Action Cable channels and rake tasks are never offered, so a PR that changes them reaches no entry point.

Support: index.rb reads config/routes.rb (verbs, namespace, scope, resources with only/except, root, conditions such as `if Rails.env.test?`; redirects and mounts run no app controller), method visibility, and rake tasks in lib/tasks. adapters/rails.mjs makes an entry point of every routed controller action (before filters, the action, after filters; a filter with if: or unless: is a fork; a gem's filter is drawn by name), every public Action Cable channel method (after the connection's connect), every job and every rake task. A Rails app without GraphQL uses that adapter alone. An entry point the adapter cannot read is marked with its code instead of stopping the codebase. Guarded by the five "entry points beyond GraphQL: …" tests and "adapters: …" in tests/framework.test.mjs.
