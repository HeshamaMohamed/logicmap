---
code: COVERAGE
status: supported
example: tests/fixtures/rails-graphql app/jobs/reminder_job.rb:9
---
A call written `self.class.window` is read as a call on an unknown object, matched by name among instance methods only, so it never reaches the class method it names, and a change there marks nothing.

Support: resolve.mjs reads `self.class.<name>` as the owner's class method. Guarded by "resolver: self.class.<name> is the owner's class method" in tests/framework.test.mjs.
