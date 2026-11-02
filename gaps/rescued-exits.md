---
code: MISSTATED
status: supported
example: tests/fixtures/rails-graphql app/services/payment_recorder.rb:4
---
A method's exit shows the request ending even when a caller rescues that exception (PaymentRecorder#record rescues RecordNotUnique), so the graph claims an ending that cannot happen on that path.

Support: index.rb records each rescue with the lines it protects. Claude names the exception class of every exit it raises (`raises`), assembly marks a step inside a protected range with `catches`, and lib/rollup.mjs (shared by the viewer) drops a caught exit from everything past the catching step. Inside the callee the exit still shows. Guarded by "rescued exits: a caller that rescues an exception drops the callee's exit from its rollup" in tests/framework.test.mjs.
