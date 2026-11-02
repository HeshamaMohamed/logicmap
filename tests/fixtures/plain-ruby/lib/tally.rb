module Tally
  def self.run(args)
    counter = Counter.new
    args.each { |arg| counter.add(Integer(arg)) }
    counter.total
  end
end
