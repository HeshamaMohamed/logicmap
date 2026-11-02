class ReminderJob < ApplicationJob
  def self.window
    3.days
  end

  def perform(payment_id)
    payment = Payment.find_by(id: payment_id)
    return unless payment
    return if payment.received_at > self.class.window.ago

    ReminderMailer.with(payment: payment).due.deliver_later
  end
end
