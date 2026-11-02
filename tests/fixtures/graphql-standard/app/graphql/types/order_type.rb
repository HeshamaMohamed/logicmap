module Types
  class OrderType < Types::BaseObject
    field :id, ID, null: false
    field :total, String, null: false

    def total
      object.paid? ? "Paid: #{object.total_cents}" : "Due: #{object.total_cents}"
    end
  end
end
