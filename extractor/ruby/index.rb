# frozen_string_literal: true

# Indexes a Ruby codebase with Prism: every class and module, every method
# with its line range and the calls inside it, class-body declarations
# (validates, before_save, guard, include…), every class-body constant, the
# constants each method reads, and constant tables built from literal hashes.
# Prints one JSON document to stdout.
#
#   ruby index.rb ROOT DIR [DIR...]
#
# Method ids: "Owner#name" for instance methods, "Owner.name" for singleton
# methods (def self.x, class << self, ActiveSupport::Concern class_methods).

require "prism"
require "json"
require "set"

class Indexer < Prism::Visitor
  attr_reader :modules, :methods, :constants, :constant_defs

  def initialize(root)
    super()
    @root = root
    @modules = {}
    @methods = {}
    @constants = []
    @constant_defs = []
    @nesting = []
    @singleton_depth = 0
    @def_stack = []
    @included_block = 0
    # Calls that are statements of a class body (or of a concern's `included`
    # block). Only these are declarations; calls inside a scope lambda are not.
    @direct = Set.new
    @visibility = []
    @next_visibility = nil
    @pending_visibility = []
    @rake_namespaces = []
    @last_desc = nil
  end

  def index_file(path)
    @file = path.delete_prefix("#{@root}/")
    @rake = path.end_with?(".rake")
    result = Prism.parse_file(path)
    unless result.errors.empty?
      warn "index.rb: #{@file}: #{result.errors.size} parse error(s), first: #{result.errors.first.message}"
    end
    @comments = {}
    result.comments.each do |comment|
      @comments[comment.location.start_line] = comment.slice
    end
    @lines = File.readlines(path)
    result.value.accept(self)
  end

  def visit_module_node(node)
    enter_namespace(node, :module, nil) { super }
  end

  def visit_class_node(node)
    enter_namespace(node, :class, node.superclass&.slice) { super }
  end

  def visit_singleton_class_node(node)
    @singleton_depth += 1
    super
  ensure
    @singleton_depth -= 1
  end

  def visit_def_node(node)
    singleton = node.receiver.is_a?(Prism::SelfNode) || @singleton_depth.positive?
    within_method(node.name.to_s, singleton, node) { super }
  end

  def visit_call_node(node)
    return visit_rake_call(node) { super } if @rake && node.receiver.nil? && @def_stack.empty? && %i[desc namespace task].include?(node.name)

    if node.receiver.nil? && @def_stack.empty? && namespace? && %i[private protected public].include?(node.name)
      args = node.arguments&.arguments || []
      if args.empty?
        @visibility[-1] = node.name.to_s unless @visibility.empty?
      elsif args.first.is_a?(Prism::DefNode)
        @next_visibility = node.name.to_s
      else
        args.each { |arg| (name = literal_name(arg)) && @pending_visibility << [current_owner, name, node.name.to_s] }
      end
    end

    # define_method(:name) { ... } with a literal name is a method like any other.
    if node.name == :define_method && node.receiver.nil? && @def_stack.empty? && node.block.is_a?(Prism::BlockNode) &&
       (name = literal_name(node.arguments&.arguments&.first))
      return within_method(name, @singleton_depth.positive?, node) { super }
    end
    # scope :name, -> { ... } defines the class method Owner.name.
    if node.name == :scope && node.receiver.nil? && @def_stack.empty? && namespace? &&
       (args = node.arguments&.arguments) && (name = literal_name(args[0])) && args[1].is_a?(Prism::LambdaNode)
      return within_method(name, true, node) { super }
    end

    if (method = @def_stack.last)
      method[:calls] << { name: node.name.to_s, receiver: receiver_of(node), line: node.location.start_line }
      # send(:name), public_send(:name) and __send__(:name) call name.
      if %i[send public_send __send__].include?(node.name) && (name = literal_name(node.arguments&.arguments&.first))
        method[:calls] << { name: name, receiver: receiver_of(node), line: node.location.start_line, via: node.name.to_s }
      end
    elsif node.receiver.nil? && namespace? && @direct.include?(node.object_id)
      record_declaration(node)
    elsif node.receiver.nil? && namespace? && %i[include prepend extend].include?(node.name)
      # An include inside a conditional (as in an `included do` block) still adds the module.
      record_inclusion(node)
    end

    if node.receiver.nil? && node.block.is_a?(Prism::BlockNode) && @def_stack.empty?
      case node.name
      when :class_methods
        @singleton_depth += 1
        begin
          super
        ensure
          @singleton_depth -= 1
        end
        return
      when :included
        mark_direct(node.block.body)
        @included_block += 1
        begin
          super
        ensure
          @included_block -= 1
        end
        return
      end
    end
    super
  end

  # A begin (or a def) with rescue clauses: the exceptions it catches and the
  # lines it protects.
  def visit_begin_node(node)
    if (method = @def_stack.last) && node.rescue_clause && node.statements
      exceptions = []
      clause = node.rescue_clause
      while clause
        names = clause.exceptions.map(&:slice)
        exceptions.concat(names.empty? ? ["StandardError"] : names)
        clause = clause.respond_to?(:subsequent) ? clause.subsequent : clause.consequent
      end
      method[:rescues] << {
        exceptions: exceptions.uniq,
        line: node.rescue_clause.location.start_line,
        protects: [node.statements.location.start_line, node.statements.location.end_line]
      }
    end
    super
  end

  # `expression rescue fallback` catches StandardError on its own line.
  def visit_rescue_modifier_node(node)
    if (method = @def_stack.last)
      line = node.location.start_line
      method[:rescues] << { exceptions: ["StandardError"], line: line, protects: [line, line] }
    end
    super
  end

  def visit_constant_read_node(node)
    @def_stack.last[:consts] << { name: node.slice, line: node.location.start_line } if @def_stack.last
    super
  end

  def visit_constant_path_node(node)
    # The whole path ("Foo::BAR") is the read; its parts are not reads of their own.
    @def_stack.last[:consts] << { name: node.slice, line: node.location.start_line } if @def_stack.last
  end

  def visit_constant_write_node(node)
    if @def_stack.empty?
      @constant_defs << {
        owner: current_owner, name: node.name.to_s, file: @file,
        start: node.location.start_line, end: node.location.end_line
      }
    end
    table = literal(node.value)
    if table.is_a?(Array) && !table.empty? && table.all? { |row| row.is_a?(Hash) }
      @constants << {
        owner: current_owner,
        name: node.name.to_s,
        file: @file,
        start: node.location.start_line,
        end: node.location.end_line,
        rows: table
      }
    end
    super
  end

  def apply_pending_visibility
    @pending_visibility.each do |owner, name, visibility|
      method = @methods["#{owner}##{name}"] || @methods["#{owner}.#{name}"]
      method[:visibility] = visibility if method
    end
  end

  private

  def enter_namespace(node, kind, superclass)
    path = node.constant_path.slice
    absolute = path.start_with?("::")
    parts = path.delete_prefix("::").split("::")
    full = (absolute ? parts : @nesting + parts).join("::")
    entry = (@modules[full] ||= {
      name: full, kind: kind, superclass: nil, includes: [], extends: [],
      nesting: @nesting.dup, declarations: [], files: []
    })
    entry[:superclass] ||= superclass
    entry[:files] << { file: @file, start: node.location.start_line, end: node.location.end_line }
    mark_direct(node.body)
    saved_nesting = @nesting
    saved_singleton = @singleton_depth
    @nesting = full.split("::")
    @singleton_depth = 0
    @visibility.push("public")
    yield
  ensure
    @visibility.pop
    @nesting = saved_nesting
    @singleton_depth = saved_singleton
  end

  def mark_direct(body)
    return unless body.is_a?(Prism::StatementsNode)

    body.body.each { |statement| @direct << statement.object_id }
  end

  def namespace?
    !@nesting.empty?
  end

  def current_owner
    @nesting.empty? ? "Object" : @nesting.join("::")
  end

  def within_method(name, singleton, node, id: nil, owner: current_owner, doc: nil)
    id ||= "#{owner}#{singleton ? '.' : '#'}#{name}"
    entry = {
      id: id,
      owner: owner,
      name: name,
      singleton: singleton,
      visibility: @next_visibility || @visibility.last || "public",
      file: @file,
      start: node.location.start_line,
      end: node.location.end_line,
      signature: @lines[node.location.start_line - 1].to_s.strip,
      doc: doc || doc_before(node.location.start_line),
      calls: [],
      consts: [],
      rescues: []
    }
    @next_visibility = nil
    @methods[id] = entry
    @def_stack.push(entry)
    yield
  ensure
    @def_stack.pop
  end

  # Rake: `namespace :a do task b: :environment do ... end end` is the task "rake:a:b".
  def visit_rake_call(node)
    args = node.arguments&.arguments || []
    case node.name
    when :desc
      @last_desc = literal_name(args.first)
      yield
    when :namespace
      @rake_namespaces.push(literal_name(args.first) || "?")
      begin
        yield
      ensure
        @rake_namespaces.pop
      end
    when :task
      name = literal_name(args.first)
      name ||= literal_name(args.first.elements.first&.key) if args.first.is_a?(Prism::KeywordHashNode) || args.first.is_a?(Prism::HashNode)
      return yield unless name && node.block

      doc = @last_desc
      @last_desc = nil
      within_method(name, false, node, id: "rake:#{(@rake_namespaces + [name]).join(':')}", owner: "rake", doc: doc.to_s) { yield }
    end
  end

  def literal_name(node)
    node.unescaped if node.is_a?(Prism::SymbolNode) || node.is_a?(Prism::StringNode)
  end

  def record_inclusion(node)
    owner = @modules[current_owner]
    return unless owner

    list = node.name == :extend ? owner[:extends] : owner[:includes]
    (node.arguments&.arguments || []).each { |arg| list << arg.slice if constant?(arg) && !list.include?(arg.slice) }
  end

  def record_declaration(node)
    owner = @modules[current_owner]
    return unless owner

    record_inclusion(node) if %i[include prepend extend].include?(node.name)
    owner[:declarations] << {
      name: node.name.to_s,
      start: node.location.start_line,
      end: node.location.end_line,
      file: @file,
      in_included_block: @included_block.positive?,
      source: node.slice.lines.first(6).join.strip[0, 400]
    }
  end

  def constant?(node)
    node.is_a?(Prism::ConstantReadNode) || node.is_a?(Prism::ConstantPathNode)
  end

  def receiver_of(node)
    receiver = node.receiver
    return nil if receiver.nil?
    return { self: true } if receiver.is_a?(Prism::SelfNode)
    return { const: receiver.slice } if constant?(receiver)

    { expr: receiver.slice.gsub(/\s+/, " ")[0, 60] }
  end

  def doc_before(line)
    doc = []
    current = line - 1
    while (text = @comments[current])
      doc.unshift(text.delete_prefix("#").strip)
      current -= 1
    end
    doc.last(4).join(" ")[0, 300]
  end

  # Literal values only; anything else becomes its source text.
  def literal(node)
    case node
    when Prism::ArrayNode then node.elements.map { |e| literal(e) }
    when Prism::HashNode, Prism::KeywordHashNode
      node.elements.each_with_object({}) do |assoc, hash|
        next unless assoc.is_a?(Prism::AssocNode)

        key = assoc.key.is_a?(Prism::SymbolNode) ? assoc.key.unescaped : assoc.key.slice
        hash[key] = literal(assoc.value)
      end
    when Prism::StringNode, Prism::SymbolNode then node.unescaped
    when Prism::IntegerNode then node.value
    when Prism::TrueNode then true
    when Prism::FalseNode then false
    when Prism::NilNode then nil
    when Prism::CallNode
      # `[...].freeze`
      node.name == :freeze && node.receiver ? literal(node.receiver) : node.slice
    else node.slice
    end
  end
end

# Reads config/routes.rb: every route with its verb, full path, controller,
# action, and the condition around it (`if Rails.env.test?`). Redirects and
# mounted engines run no controller of the app and are left out.
class RoutesReader < Prism::Visitor
  VERBS = %i[get post put patch delete].freeze
  RESOURCE_ACTIONS = [
    ["index", "GET", ""], ["create", "POST", ""], ["new", "GET", "/new"], ["edit", "GET", "/:id/edit"],
    ["show", "GET", "/:id"], ["update", "PATCH", "/:id"], ["destroy", "DELETE", "/:id"]
  ].freeze

  def self.read(path)
    reader = new
    Prism.parse_file(path).value.accept(reader)
    reader.routes
  end

  attr_reader :routes

  def initialize
    super()
    @routes = []
    @paths = []
    @modules = []
    @conditions = []
    @controller = nil
  end

  def visit_if_node(node)
    @conditions.push(node.predicate.slice)
    visit(node.statements) if node.statements
    @conditions.pop
    visit(node.subsequent) if node.respond_to?(:subsequent) && node.subsequent
  end

  def visit_unless_node(node)
    @conditions.push("not #{node.predicate.slice}")
    visit(node.statements) if node.statements
    @conditions.pop
  end

  def visit_call_node(node)
    return super unless node.receiver.nil?

    args = node.arguments&.arguments || []
    opts = options(args)
    case node.name
    when :namespace
      name = text(args.first)
      within("/#{name}", name, nil) { visit(node.block) if node.block }
    when :scope
      path = text(args.first) || opts["path"]
      within(path ? "/#{path.delete_prefix('/')}" : nil, opts["module"], opts["controller"]) { visit(node.block) if node.block }
    when :resources, :resource
      resources(node, args, opts, singular: node.name == :resource)
    when :root
      add("GET", "/", opts["to"] || text(args.first), node)
    when *VERBS
      verb(node, args, opts)
    when :mount
      nil
    else
      super
    end
  end

  private

  def within(path, mod, controller)
    @paths.push(path)
    @modules.push(mod)
    saved = @controller
    @controller = controller if controller
    yield
  ensure
    @paths.pop
    @modules.pop
    @controller = saved
  end

  def verb(node, args, opts)
    first = args.first
    path = text(first)
    to = opts["to"]
    if first.is_a?(Prism::KeywordHashNode) || first.is_a?(Prism::HashNode)
      assoc = first.elements.find { |e| e.is_a?(Prism::AssocNode) && e.key.is_a?(Prism::StringNode) }
      path = assoc&.key&.unescaped
      to = text(assoc&.value)
    end
    return if to == :redirect

    to ||= "#{opts['controller'] || @controller}##{opts['action'] || path}" if path && (opts["controller"] || @controller)
    add(node.name.to_s.upcase, path, to, node)
  end

  def resources(node, args, opts, singular:)
    name = text(args.first)
    return unless name

    only = list(opts["only"])
    except = list(opts["except"]) || []
    controller = opts["controller"] || (singular ? "#{name}s" : name)
    RESOURCE_ACTIONS.each do |action, verb, suffix|
      next if singular && action == "index"
      next if only && !only.include?(action)
      next if except.include?(action)

      add(verb, "/#{name}#{singular ? suffix.sub('/:id', '') : suffix}", "#{controller}##{action}", node)
    end
    within("/#{name}#{singular ? '' : "/:#{name.chomp('s')}_id"}", nil, controller) { visit(node.block) } if node.block
  end

  def add(verb, path, to, node)
    return unless to.is_a?(String) && to.include?("#")

    controller, action = to.split("#", 2)
    full = "/#{[*@paths.compact.map { |p| p.delete_prefix('/') }, path.to_s.delete_prefix('/')].reject(&:empty?).join('/')}"
    controller = [*@modules.compact, controller].join("/") unless controller.start_with?("/")
    @routes << {
      verb: verb, path: full, controller: controller.delete_prefix("/"), action: action,
      condition: @conditions.empty? ? nil : @conditions.join(" and "), line: node.location.start_line
    }
  end

  def options(args)
    hash = args.find { |a| a.is_a?(Prism::KeywordHashNode) }
    return {} unless hash

    hash.elements.each_with_object({}) do |e, out|
      next unless e.is_a?(Prism::AssocNode) && e.key.is_a?(Prism::SymbolNode)

      out[e.key.unescaped] = e.value.is_a?(Prism::CallNode) && e.value.name == :redirect ? :redirect : (text(e.value) || e.value)
    end
  end

  def list(value)
    return nil if value.nil?
    return [value] if value.is_a?(String)
    return value.elements.map { |e| text(e) }.compact if value.is_a?(Prism::ArrayNode)

    nil
  end

  def text(node)
    node.unescaped if node.is_a?(Prism::StringNode) || node.is_a?(Prism::SymbolNode)
  end
end

root = File.expand_path(ARGV.shift || abort("usage: ruby index.rb ROOT PATH [PATH...]"))
paths = ARGV.empty? ? %w[app lib] : ARGV
indexer = Indexer.new(root)
files = paths.flat_map do |path|
  full = File.join(root, path)
  if File.file?(full) then [full]
  elsif File.directory?(full) then Dir.glob(File.join(full, "**", "*.{rb,rake}"))
  else []
  end
end.uniq.sort
routes_file = File.join(root, "config", "routes.rb")
(files - [routes_file]).each { |path| indexer.index_file(path) }
indexer.apply_pending_visibility
routes = files.include?(routes_file) ? RoutesReader.read(routes_file) : []

puts JSON.generate(
  root: root,
  files: files.size,
  files_read: files.map { |f| f.delete_prefix("#{root}/") },
  routes: routes,
  modules: indexer.modules,
  methods: indexer.methods,
  constants: indexer.constants,
  constant_defs: indexer.constant_defs
)
