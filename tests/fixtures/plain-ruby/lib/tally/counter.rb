module Tally
  class Counter
    LIMIT = 1_000

    attr_reader :total

    def initialize
      @total = 0
    end

    def add(amount)
      raise ArgumentError, "negative amount" if amount.negative?

      @total = capped(@total + amount)
    end

    private

    def capped(value)
      [value, LIMIT].min
    end
  end
end
