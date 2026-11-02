class RecordPaymentJob < ApplicationJob
  def perform(project_id, amount_cents)
    PaymentRecorder.new.record(Project.find(project_id), amount_cents)
  end
end
