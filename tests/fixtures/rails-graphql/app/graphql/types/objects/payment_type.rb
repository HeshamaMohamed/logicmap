module Types
  module Objects
    class PaymentType < Types::BaseObject
      field :id, ID, null: false
      field :receipt_url, String, null: true
      field :project, Types::Objects::ProjectType, null: false

      def receipt_url
        return nil if object.refunded?

        "/receipts/#{object.id}"
      end
    end
  end
end
