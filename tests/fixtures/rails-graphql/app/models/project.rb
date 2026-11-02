class Project < ApplicationRecord
  has_many :payments

  def archived?
    closed_statuses.include?(status)
  end

  def member?(user)
    memberships.exists?(user: user)
  end

  private

  def closed_statuses
    %w[archived]
  end
end
