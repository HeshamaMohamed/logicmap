module Resolvers
  class Orders < GraphQL::Schema::Resolver
    type [Types::OrderType], null: false

    argument :paid, Boolean, required: false

    def resolve(paid: nil)
      paid.nil? ? Order.all : Order.where(paid: paid)
    end
  end
end
