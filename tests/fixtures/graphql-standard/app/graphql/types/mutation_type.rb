module Types
  class MutationType < Types::BaseObject
    field :place_order, mutation: Mutations::PlaceOrder
  end
end
