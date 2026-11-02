module ProjectScoped
  extend ActiveSupport::Concern

  included do
    # Every query of the model is limited to the current project.
    default_scope { where(project_id: Current.project_id!) }
  end
end
