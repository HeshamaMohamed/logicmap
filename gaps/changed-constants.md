---
code: COVERAGE
status: supported
example: tests/fixtures/rails-graphql app/graphql/mutations/payments/create_payment.rb:11
---
A change to a class-body constant (MAX_AMOUNT_CENTS) is listed as uncovered, though the steps that read it now decide differently, so the reviewer sees the new limit only in the diff.

Support: the index records class-body constant definitions and the constants each method reads; affected.mjs counts a method reading a changed constant as changed, and markIndirect marks the step holding the read. Guarded by "change: a changed constant marks the steps that read it" in tests/framework.test.mjs.
