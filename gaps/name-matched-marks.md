---
code: MISSTATED
status: supported
example: tests/fixtures/rails-graphql app/controllers/health_controller.rb:4
---
A change marked steps it never touches: a controller's `render` was matched by name to a template class's `render` (ReceiptTemplate#render), so a change to that template showed the controller's "Send the result as JSON" step as modified.

Support: markIndirect follows only calls the resolver resolved (self, constant, self.class, receiver name), never name-only matches, and resolve.mjs never name-matches Ruby and Rails basics (render, head, params, blank?, to_s and similar). Guarded by "change: a mark follows only resolved calls, and Ruby or Rails basics are never matched by name" in tests/framework.test.mjs.
