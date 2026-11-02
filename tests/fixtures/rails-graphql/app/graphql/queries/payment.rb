module Queries
  class Payment < Queries::BaseQuery
    type Types::Objects::PaymentType, null: true

    argument :id, ID, required: true

    def resolve(id:)
      ::Payment.find_by(id: id)
    end
  end
end
