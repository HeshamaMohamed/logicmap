class ReceiptTemplate
  def render(payment)
    "Receipt #{payment.id}: #{payment.amount_cents}"
  end
end
