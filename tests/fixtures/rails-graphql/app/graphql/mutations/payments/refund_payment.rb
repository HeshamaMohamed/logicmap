module Mutations
  module Payments
    class RefundPayment < Mutations::BaseMutation
      description "Refund a payment fully or in part"

      guard :authenticated!

      def resolve(payment_id:, amount_cents: nil)
        payment = Payment.find(payment_id)
        ActiveRecord::Base.transaction do
          if amount_cents.nil? || amount_cents >= payment.amount_cents
            payment.update!(status: "refunded")
          else
            payment.update!(amount_cents: payment.amount_cents - amount_cents)
            payment.notes.create!(body: "Partial refund of #{amount_cents}")
          end
        end
        success(payment: payment)
      end
    end
  end
end
