module Mutations
  class PlaceOrder < BaseMutation
    argument :total_cents, Integer, required: true

    field :order, Types::OrderType, null: true
    field :errors, [String], null: false

    def authorized?(**_args)
      context[:current_user].present? || raise(GraphQL::ExecutionError, "Sign in first")
    end

    def resolve(total_cents:)
      order = Order.new(total_cents: total_cents)
      if order.save
        { order: order, errors: [] }
      else
        { order: nil, errors: order.errors.full_messages }
      end
    end
  end
end
