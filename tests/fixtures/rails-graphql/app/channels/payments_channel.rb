class PaymentsChannel < ApplicationCable::Channel
  def subscribed
    reject unless current_user.active?

    stream_for current_user
  end

  def refresh(data)
    transmit(payments: recent(data["limit"]))
  end

  private

  def recent(limit)
    Payment.order(created_at: :desc).limit([limit.to_i, 20].min)
  end
end
