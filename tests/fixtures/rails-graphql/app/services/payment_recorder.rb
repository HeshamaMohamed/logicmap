class PaymentRecorder
  def record(project, amount_cents)
    store(project, amount_cents)
  rescue ActiveRecord::RecordNotUnique
    project.payments.find_by!(amount_cents: amount_cents)
  end

  def store(project, amount_cents)
    raise ActiveRecord::RecordNotUnique, "duplicate" if project.payments.exists?(amount_cents: amount_cents)

    project.payments.create!(amount_cents: amount_cents)
  end
end
