---
code: COVERAGE
status: supported
example: tests/fixtures/rails-graphql app/models/concerns/project_scoped.rb:6
---
Scopes, enums, associations and default_scope live in class bodies outside validations and callbacks, so their decisions are context only. ProjectScoped's default_scope refuses every read with no project selected, and no graph shows it.

Support: a `scope` is indexed as the class method it defines. resolve.mjs builds one declaration unit per owner and kind (validations, callbacks, associations, attribute rules, default_scope), for classes and for concerns whose `included` block declares them; a model reaches its own units and its concerns' units when a method saves, deletes or queries it, and a default scope may end the request. The rails-graphql adapter adds each mutation's and query's arguments and result as its first unit. Lines that stay out of the graph get a reason a reviewer can act on (comments only, includes or visibility, or the declaration's name). Guarded by "class-body declarations: …" and "change: lines the graph can't draw get a reason a reviewer can act on" in tests/framework.test.mjs.
