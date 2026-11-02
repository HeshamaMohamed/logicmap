module Queries
  class BaseQuery < GraphQL::Schema::Resolver
    include SessionChecks
  end
end
