module Types
  module Objects
    class ProjectType < Types::BaseObject
      field :id, ID, null: false
      field :status_label, String, null: false

      def status_label
        object.archived? ? "Archived" : "Open"
      end
    end
  end
end
