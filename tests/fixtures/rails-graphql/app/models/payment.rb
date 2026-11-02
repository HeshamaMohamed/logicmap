class Payment < ApplicationRecord
  belongs_to :project

  validates :amount_cents, numericality: { only_integer: true, greater_than: 0 }
  validates :received_at, presence: true

  before_save :stamp_currency

  has_many :notes, dependent: :destroy
  enum :status, { pending: "pending", refunded: "refunded", void: "void" }
  scope :refunded, -> { where(status: "refunded") }
  include ProjectScoped

  private

  def stamp_currency
    self.currency ||= "EUR"
  end

  def archived?
    status == "void"
  end
end
