class PaymentNotifier
  define_method(:notify_by_email) do |payment|
    deliver(:email, payment)
  end

  def notify(payment)
    public_send(:notify_by_email, payment)
  end

  def deliver(channel, payment)
    return false if payment.project.archived?

    Mailer.deliver(channel, payment)
  end
end
