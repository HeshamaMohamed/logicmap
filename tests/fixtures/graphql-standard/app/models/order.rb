class Order < ApplicationRecord
  validates :total_cents, numericality: { greater_than: 0 }
end
