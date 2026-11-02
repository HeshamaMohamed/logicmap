namespace :payments do
  desc "Queue a reminder for every unpaid payment older than three days"
  task remind: :environment do
    Payment.where(status: "pending").find_each { |payment| ReminderJob.perform_later(payment.id) }
  end
end
