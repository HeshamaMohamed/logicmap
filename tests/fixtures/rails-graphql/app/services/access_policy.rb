class AccessPolicy
  def self.permitted?(user, project)
    new(user, project).permitted?
  end

  def initialize(user, project)
    @user = user
    @project = project
  end

  def permitted?
    return false unless @user.active?
    return true if @user.admin?
    return false if @project.archived?

    @project.member?(@user)
  end
end
