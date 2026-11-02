module Mutations
  module Payments
    class CreatePayment < Mutations::BaseMutation
      description "Record a payment on a project"

      guard :authenticated!

      argument :project_id, ID, required: true
      argument :amount_cents, Integer, required: true
      result_field :payment, Types::Objects::PaymentType
      MAX_AMOUNT_CENTS = 1_000_000

      def resolve(project_id:, amount_cents:)
        raise ArgumentError, "Amount too large" if amount_cents > MAX_AMOUNT_CENTS

        project = Project.find(project_id)
        raise Pundit::NotAuthorizedError unless AccessPolicy.permitted?(current_user, project)

        payment = project.payments.new(amount_cents: amount_cents)
        return failure(payment) unless payment.valid?

        payment.save!
        success(payment: payment)
      end
    end
  end
end
