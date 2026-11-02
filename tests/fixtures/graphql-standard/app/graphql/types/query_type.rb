module Types
  class QueryType < Types::BaseObject
    field :order, Types::OrderType, null: true do
      argument :id, ID, required: true
    end

    field :orders, resolver: Resolvers::Orders

    def order(id:)
      Order.find(id)
    end
  end
end
