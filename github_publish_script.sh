#!/bin/bash

# 增强版Github项目发布脚本 - 完全交互式
# 使用方法: 
#   交互式（推荐）: ./publish_to_github.sh <project_directory>
#   命令行参数:    ./publish_to_github.sh <project_directory> [commit_message] [author_name] [author_email]
#
# 特性：
#   - 完全交互式，所有信息可交互输入
#   - 回车使用智能默认值
#   - 支持首次发布和更新推送
#   - 自动检测项目类型和变更
#   - 智能版本标签管理 (语义化版本)
#   - 本地和远程版本比较
#   - 自动检测项目文件中的版本号

set -e  # 遇到错误立即退出

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 全局变量
PROJECT_DIR=""
PROJECT_NAME=""
ORIGINAL_DIR=""
REPO_URL=""
COMMIT_MSG=""
AUTHOR_NAME=""
AUTHOR_EMAIL=""
IS_UPDATE=false
CURRENT_TAG=""
REMOTE_TAG=""
NEW_TAG=""
TAG_MESSAGE=""
CREATE_TAG=false
TAG_TYPE=""

# 打印彩色消息
print_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

print_update() {
    echo -e "${CYAN}[UPDATE]${NC} $1"
}

print_tag() {
    echo -e "${YELLOW}[TAG]${NC} $1"
}

# 显示使用方法
show_usage() {
    echo "使用方法:"
    echo "  $0 <project_directory> [commit_message] [author_name] [author_email]"
    echo
    echo "参数说明:"
    echo "  project_directory  - 项目目录路径（必需）"
    echo "  commit_message     - 提交信息（可选，可交互输入）"
    echo "  author_name        - 发布者姓名（可选，可交互输入）"
    echo "  author_email       - 联系邮箱（可选，可交互输入）"
    echo
    echo "交互式使用（推荐）:"
    echo "  $0 ~/Documents/DevProjects/Model-response-test"
    echo "  脚本会交互式询问所有必要信息，回车使用默认值"
    echo
    echo "命令行参数使用:"
    echo "  $0 /path/to/project \"Initial commit\" \"John Doe\" \"john@example.com\""
    echo
    echo "混合使用:"
    echo "  $0 ~/my-project \"fix: 修复bug\"  # 其他信息交互输入"
}

# 检查和解析参数
parse_arguments() {
    if [ $# -lt 1 ]; then
        print_error "缺少项目目录参数"
        echo
        show_usage
        exit 1
    fi
    
    PROJECT_DIR="$1"
    COMMIT_MSG="$2"
    AUTHOR_NAME="$3"
    AUTHOR_EMAIL="$4"
    
    # 记录原始目录
    ORIGINAL_DIR=$(pwd)
    
    # 展开波浪号和相对路径
    PROJECT_DIR=$(eval echo "$PROJECT_DIR")
    PROJECT_DIR=$(realpath "$PROJECT_DIR" 2>/dev/null || echo "$PROJECT_DIR")
    
    # 获取项目名称（目录的最后一部分）
    PROJECT_NAME=$(basename "$PROJECT_DIR")
    
    print_info "项目目录: $PROJECT_DIR"
    print_info "项目名称: $PROJECT_NAME"
}

# 验证目录
validate_directory() {
    if [ ! -d "$PROJECT_DIR" ]; then
        print_error "目录不存在: $PROJECT_DIR"
        exit 1
    fi
    
    if [ ! -r "$PROJECT_DIR" ] || [ ! -w "$PROJECT_DIR" ]; then
        print_error "目录权限不足: $PROJECT_DIR"
        exit 1
    fi
    
    print_success "目录验证通过"
}

# 切换到项目目录
change_to_project_dir() {
    print_info "切换到项目目录..."
    cd "$PROJECT_DIR"
    print_success "当前目录: $(pwd)"
}

# 恢复到原始目录
restore_original_dir() {
    cd "$ORIGINAL_DIR"
}

# ===========================================
# 版本和标签管理功能
# ===========================================

# 检查版本号格式是否有效 (语义化版本)
validate_version() {
    local version="$1"
    if [[ "$version" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$ ]]; then
        return 0
    else
        return 1
    fi
}

# 从版本字符串中提取数字部分
extract_version_numbers() {
    local version="$1"
    # 移除 'v' 前缀和后缀
    version=$(echo "$version" | sed 's/^v//' | sed 's/-.*$//' | sed 's/+.*$//')
    echo "$version"
}

# 比较两个版本号
compare_versions() {
    local version1="$1"
    local version2="$2"
    
    # 提取纯数字版本
    local v1=$(extract_version_numbers "$version1")
    local v2=$(extract_version_numbers "$version2")
    
    # 使用sort -V进行版本比较
    if [[ "$v1" == "$v2" ]]; then
        echo "equal"
    elif printf '%s\n%s\n' "$v1" "$v2" | sort -V | head -n1 | grep -q "^$v1$"; then
        echo "less"
    else
        echo "greater"
    fi
}

# 获取本地最新标签
get_local_latest_tag() {
    if git tag -l | grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+' | sort -V | tail -n1; then
        return 0
    else
        echo ""
        return 1
    fi
}

# 获取远程最新标签
get_remote_latest_tag() {
    if [ "$IS_UPDATE" = true ] && git ls-remote --tags origin &> /dev/null; then
        git ls-remote --tags origin | \
        grep -E 'refs/tags/v?[0-9]+\.[0-9]+\.[0-9]+' | \
        sed 's/.*refs\/tags\///' | \
        sort -V | \
        tail -n1
    else
        echo ""
        return 1
    fi
}

# 增加版本号
increment_version() {
    local current_version="$1"
    local increment_type="$2"
    
    # 提取版本号组件
    local clean_version=$(extract_version_numbers "$current_version")
    
    if ! validate_version "$clean_version"; then
        echo "1.0.0"
        return
    fi
    
    # 解析版本号
    local major=$(echo "$clean_version" | cut -d. -f1)
    local minor=$(echo "$clean_version" | cut -d. -f2)
    local patch=$(echo "$clean_version" | cut -d. -f3)
    
    case "$increment_type" in
        "major")
            major=$((major + 1))
            minor=0
            patch=0
            ;;
        "minor")
            minor=$((minor + 1))
            patch=0
            ;;
        "patch")
            patch=$((patch + 1))
            ;;
        *)
            print_error "无效的版本增量类型: $increment_type"
            return 1
            ;;
    esac
    
    echo "v$major.$minor.$patch"
}

# 检测项目版本信息
detect_project_version() {
    local version=""
    
    # 检查package.json
    if [ -f "package.json" ] && command -v jq &> /dev/null; then
        version=$(jq -r '.version // empty' package.json 2>/dev/null)
        if [ -n "$version" ]; then
            echo "v$version"
            return
        fi
    fi
    
    # 检查package.json (不用jq)
    if [ -f "package.json" ]; then
        version=$(grep '"version"' package.json | head -1 | sed 's/.*"version".*"\([^"]*\)".*/\1/')
        if [ -n "$version" ] && [ "$version" != "package.json" ]; then
            echo "v$version"
            return
        fi
    fi
    
    # 检查Cargo.toml
    if [ -f "Cargo.toml" ]; then
        version=$(grep '^version' Cargo.toml | head -1 | sed 's/version.*=.*"\([^"]*\)".*/\1/')
        if [ -n "$version" ]; then
            echo "v$version"
            return
        fi
    fi
    
    # 检查pyproject.toml
    if [ -f "pyproject.toml" ]; then
        version=$(grep '^version' pyproject.toml | head -1 | sed 's/version.*=.*"\([^"]*\)".*/\1/')
        if [ -n "$version" ]; then
            echo "v$version"
            return
        fi
    fi
    
    # 检查setup.py
    if [ -f "setup.py" ]; then
        version=$(grep 'version.*=' setup.py | head -1 | sed "s/.*version.*=.*[\"']\([^\"']*\)[\"'].*/\1/")
        if [ -n "$version" ]; then
            echo "v$version"
            return
        fi
    fi
    
    echo ""
}

# 显示版本状态
show_version_status() {
    print_tag "版本状态概览:"
    
    # 本地标签
    CURRENT_TAG=$(get_local_latest_tag)
    if [ -n "$CURRENT_TAG" ]; then
        print_tag "本地最新标签: $CURRENT_TAG"
    else
        print_tag "本地最新标签: 未找到"
    fi
    
    # 远程标签
    if [ "$IS_UPDATE" = true ]; then
        REMOTE_TAG=$(get_remote_latest_tag)
        if [ -n "$REMOTE_TAG" ]; then
            print_tag "远程最新标签: $REMOTE_TAG"
            
            # 比较本地和远程版本
            if [ -n "$CURRENT_TAG" ]; then
                local comparison=$(compare_versions "$CURRENT_TAG" "$REMOTE_TAG")
                case "$comparison" in
                    "equal")
                        print_tag "版本状态: 本地和远程版本一致"
                        ;;
                    "less")
                        print_warning "版本状态: 本地版本较旧，建议同步"
                        ;;
                    "greater")
                        print_tag "版本状态: 本地版本较新"
                        ;;
                esac
            fi
        else
            print_tag "远程最新标签: 未找到"
        fi
    fi
    
    # 项目文件中的版本
    local project_version=$(detect_project_version)
    if [ -n "$project_version" ]; then
        print_tag "项目文件版本: $project_version"
    fi
    
    echo
}

# 交互式选择版本增量类型
select_version_increment() {
    local current="$1"
    
    echo
    print_tag "选择版本增量类型:"
    
    # 计算各种增量的结果
    local major_version=""
    local minor_version=""
    local patch_version=""
    
    if [ -n "$current" ]; then
        major_version=$(increment_version "$current" "major")
        minor_version=$(increment_version "$current" "minor")
        patch_version=$(increment_version "$current" "patch")
        
        echo "  1) Patch (修复): $current → $patch_version"
        echo "  2) Minor (功能): $current → $minor_version"
        echo "  3) Major (重大): $current → $major_version"
    else
        echo "  1) Patch (修复): → v0.0.1"
        echo "  2) Minor (功能): → v0.1.0"
        echo "  3) Major (重大): → v1.0.0"
    fi
    
    echo "  4) 自定义版本号"
    echo "  5) 跳过标签创建"
    echo
    
    while true; do
        echo -n "请选择 (1-5, 默认: 1): "
        read choice
        
        # 默认选择patch
        if [ -z "$choice" ]; then
            choice=1
        fi
        
        case "$choice" in
            1)
                TAG_TYPE="patch"
                if [ -n "$current" ]; then
                    NEW_TAG=$patch_version
                else
                    NEW_TAG="v0.0.1"
                fi
                CREATE_TAG=true
                break
                ;;
            2)
                TAG_TYPE="minor"
                if [ -n "$current" ]; then
                    NEW_TAG=$minor_version
                else
                    NEW_TAG="v0.1.0"
                fi
                CREATE_TAG=true
                break
                ;;
            3)
                TAG_TYPE="major"
                if [ -n "$current" ]; then
                    NEW_TAG=$major_version
                else
                    NEW_TAG="v1.0.0"
                fi
                CREATE_TAG=true
                break
                ;;
            4)
                echo -n "请输入自定义版本号 (格式: v1.2.3): "
                read custom_version
                
                if validate_version "$custom_version"; then
                    NEW_TAG="$custom_version"
                    TAG_TYPE="custom"
                    CREATE_TAG=true
                    break
                else
                    print_error "版本号格式无效，请使用 vX.Y.Z 格式"
                fi
                ;;
            5)
                CREATE_TAG=false
                print_info "跳过标签创建"
                break
                ;;
            *)
                print_error "无效选择，请输入 1-5"
                ;;
        esac
    done
}

# 创建标签
create_git_tag() {
    if [ "$CREATE_TAG" != true ]; then
        return 0
    fi
    
    # 检查标签是否已存在
    if git tag -l | grep -q "^$NEW_TAG$"; then
        print_warning "标签 $NEW_TAG 已存在"
        echo -n "是否要删除现有标签并重新创建? (y/N): "
        read confirm
        
        if [[ "$confirm" =~ ^[Yy]$ ]]; then
            git tag -d "$NEW_TAG"
            if [ "$IS_UPDATE" = true ]; then
                git push origin --delete "$NEW_TAG" 2>/dev/null || true
            fi
        else
            print_info "跳过标签创建"
            CREATE_TAG=false
            return 0
        fi
    fi
    
    # 获取标签消息
    if [ -z "$TAG_MESSAGE" ]; then
        local default_msg="Release $NEW_TAG - $(date '+%Y-%m-%d')"
        echo
        echo -n "请输入标签描述 (直接回车使用: $default_msg): "
        read TAG_MESSAGE
        
        if [ -z "$TAG_MESSAGE" ]; then
            TAG_MESSAGE="$default_msg"
        fi
    fi
    
    # 创建带注释的标签
    print_tag "创建标签: $NEW_TAG"
    git tag -a "$NEW_TAG" -m "$TAG_MESSAGE"
    print_success "标签 $NEW_TAG 已创建"
}

# 推送标签到远程
push_tags() {
    if [ "$CREATE_TAG" = true ]; then
        print_tag "推送标签到远程仓库..."
        
        if git push origin "$NEW_TAG"; then
            print_success "标签 $NEW_TAG 已推送到远程"
        else
            print_warning "标签推送失败，但代码已成功推送"
        fi
        
        # 推送所有标签
        echo -n "是否推送所有本地标签到远程? (y/N): "
        read push_all
        
        if [[ "$push_all" =~ ^[Yy]$ ]]; then
            git push origin --tags
            print_success "所有标签已推送到远程"
        fi
    fi
}

# 同步远程标签
sync_remote_tags() {
    if [ "$IS_UPDATE" = true ]; then
        print_tag "同步远程标签..."
        git fetch origin --tags 2>/dev/null || true
        print_success "远程标签已同步"
    fi
}

# 检查git是否安装
check_git() {
    if ! command -v git &> /dev/null; then
        print_error "Git 未安装，请先安装 Git"
        exit 1
    fi
}

# 检测是否为现有git仓库
detect_existing_repo() {
    if [ -d ".git" ]; then
        print_update "检测到现有Git仓库"
        IS_UPDATE=true
        
        # 检查是否有远程仓库
        if git remote get-url origin &> /dev/null; then
            REPO_URL=$(git remote get-url origin)
            print_update "检测到远程仓库: $REPO_URL"
        fi
        
        return 0
    else
        print_info "这是新项目，将进行首次发布"
        IS_UPDATE=false
        return 1
    fi
}

# 初始化git仓库
init_git_if_needed() {
    if [ "$IS_UPDATE" = false ]; then
        print_info "初始化Git仓库..."
        git init
        print_success "Git仓库初始化完成"
    fi
}

# 交互式设置Git用户信息
setup_git_user() {
    local current_name=""
    local current_email=""
    local github_username=""
    local default_name=""
    local default_email=""
    
    # 获取当前git配置
    if git config user.name &> /dev/null; then
        current_name=$(git config user.name)
    fi
    
    if git config user.email &> /dev/null; then
        current_email=$(git config user.email)
    fi
    
    # 尝试从远程仓库URL推断Github用户名
    if [ -n "$REPO_URL" ]; then
        if [[ "$REPO_URL" =~ github\.com[:/]([^/]+)/ ]]; then
            github_username="${BASH_REMATCH[1]}"
        fi
    fi
    
    # 确定默认值
    if [ -n "$current_name" ]; then
        default_name="$current_name"
    elif [ -n "$github_username" ]; then
        default_name="$github_username"
    else
        default_name="Github Owner"
    fi
    
    if [ -n "$current_email" ]; then
        default_email="$current_email"
    else
        default_email="noreply@github.com"
    fi
    
    # 交互式设置作者姓名（如果未通过参数提供）
    if [ -z "$AUTHOR_NAME" ]; then
        echo
        print_info "设置发布者信息"
        print_info "当前Git用户名: ${current_name:-"未设置"}"
        echo -n "请输入发布者姓名 (直接回车使用: $default_name): "
        read AUTHOR_NAME
        
        if [ -z "$AUTHOR_NAME" ]; then
            AUTHOR_NAME="$default_name"
        fi
    fi
    
    # 交互式设置作者邮箱（如果未通过参数提供）
    if [ -z "$AUTHOR_EMAIL" ]; then
        print_info "当前Git邮箱: ${current_email:-"未设置"}"
        echo -n "请输入联系邮箱 (直接回车使用: $default_email): "
        read AUTHOR_EMAIL
        
        if [ -z "$AUTHOR_EMAIL" ]; then
            AUTHOR_EMAIL="$default_email"
        fi
    fi
    
    # 应用设置
    git config user.name "$AUTHOR_NAME"
    git config user.email "$AUTHOR_EMAIL"
    
    print_success "Git用户配置: $AUTHOR_NAME <$AUTHOR_EMAIL>"
}

# 获取Github仓库URL
get_github_repo() {
    # 如果是更新且已有远程仓库，直接使用
    if [ "$IS_UPDATE" = true ] && [ -n "$REPO_URL" ]; then
        print_update "使用现有远程仓库: $REPO_URL"
        return
    fi
    
    # 检查是否已有远程仓库（防止重复添加）
    if git remote get-url origin &> /dev/null; then
        REPO_URL=$(git remote get-url origin)
        print_info "使用现有远程仓库: $REPO_URL"
        return
    fi
    
    # 生成建议的默认URL
    local suggested_url=""
    local github_username=""
    
    # 尝试推断Github用户名
    if [ -n "$AUTHOR_NAME" ] && [[ "$AUTHOR_NAME" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        github_username="$AUTHOR_NAME"
    elif git config user.name &> /dev/null; then
        local git_name=$(git config user.name)
        if [[ "$git_name" =~ ^[a-zA-Z0-9_-]+$ ]]; then
            github_username="$git_name"
        fi
    fi
    
    if [ -n "$github_username" ]; then
        suggested_url="https://github.com/$github_username/$PROJECT_NAME.git"
    fi
    
    # 显示建议的URL
    echo
    print_info "建议的Github仓库URL格式:"
    if [ -n "$github_username" ]; then
        echo "  HTTPS: https://github.com/$github_username/$PROJECT_NAME.git"
        echo "  SSH:   git@github.com:$github_username/$PROJECT_NAME.git"
    else
        echo "  HTTPS: https://github.com/YOUR_USERNAME/$PROJECT_NAME.git"
        echo "  SSH:   git@github.com:YOUR_USERNAME/$PROJECT_NAME.git"
    fi
    echo
    
    # 交互式输入仓库URL
    print_warning "提示: 请先在Github网站创建仓库 '$PROJECT_NAME'"
    if [ -n "$suggested_url" ]; then
        echo -n "请输入Github仓库URL (直接回车使用: $suggested_url): "
    else
        echo -n "请输入Github仓库URL: "
    fi
    
    read REPO_URL
    
    # 使用默认值
    if [ -z "$REPO_URL" ] && [ -n "$suggested_url" ]; then
        REPO_URL="$suggested_url"
        print_info "使用建议URL: $REPO_URL"
    elif [ -z "$REPO_URL" ]; then
        print_error "仓库URL不能为空"
        exit 1
    fi
    
    # 验证URL格式
    if [[ ! "$REPO_URL" =~ ^(https://github\.com/|git@github\.com:) ]]; then
        print_warning "URL格式可能不正确，但继续尝试..."
    fi
    
    # 添加远程仓库
    git remote add origin "$REPO_URL"
    print_success "已添加远程仓库: $REPO_URL"
}

# 获取提交信息
get_commit_message() {
    if [ -n "$COMMIT_MSG" ]; then
        print_info "使用提供的提交信息: $COMMIT_MSG"
        return
    fi
    
    # 生成默认提交信息
    local default_msg=""
    if [ "$IS_UPDATE" = true ]; then
        default_msg="update: $PROJECT_NAME - $(date '+%Y-%m-%d %H:%M:%S')"
    else
        default_msg="initial commit: $PROJECT_NAME - $(date '+%Y-%m-%d %H:%M:%S')"
    fi
    
    echo
    if [ "$IS_UPDATE" = true ]; then
        echo -n "请输入更新的提交信息 (直接回车使用: $default_msg): "
    else
        echo -n "请输入首次提交信息 (直接回车使用: $default_msg): "
    fi
    
    read COMMIT_MSG
    
    if [ -z "$COMMIT_MSG" ]; then
        COMMIT_MSG="$default_msg"
    fi
    
    print_info "提交信息: $COMMIT_MSG"
}

# 检查工作区状态
check_working_directory() {
    # 检查是否有文件
    if [ -z "$(ls -A .)" ]; then
        print_error "项目目录为空，没有文件可以提交"
        return 1
    fi
    
    # 如果是新仓库，直接返回可以提交
    if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
        print_info "新仓库，准备进行首次提交"
        return 0
    fi
    
    # 检查是否有变更
    if git diff-index --quiet HEAD --; then
        if [ "$IS_UPDATE" = true ]; then
            print_update "工作区没有变更，检查未跟踪的文件..."
            
            # 检查是否有未跟踪的文件
            if [ -n "$(git ls-files --others --exclude-standard)" ]; then
                print_update "发现未跟踪的文件，需要添加"
                return 0
            else
                print_warning "没有发现任何变更，无需推送"
                return 1
            fi
        else
            print_warning "工作区没有变更"
            return 1
        fi
    fi
    
    if [ "$IS_UPDATE" = true ]; then
        print_update "检测到文件变更，准备推送更新"
    fi
    
    return 0
}

# 显示文件状态
show_status() {
    print_info "项目文件概览:"
    ls -la | head -10
    if [ $(ls -la | wc -l) -gt 10 ]; then
        echo "... (还有更多文件)"
    fi
    echo
    
    if git rev-parse --verify HEAD >/dev/null 2>&1; then
        if [ "$IS_UPDATE" = true ]; then
            print_update "变更状态:"
            git status --short
            
            # 显示详细变更统计
            if ! git diff-index --quiet HEAD --; then
                echo
                print_update "变更统计:"
                git diff --stat
            fi
            
            # 显示未跟踪的文件
            local untracked=$(git ls-files --others --exclude-standard)
            if [ -n "$untracked" ]; then
                echo
                print_update "未跟踪的文件:"
                echo "$untracked"
            fi
        else
            print_info "Git状态:"
            git status --short
        fi
    else
        print_info "这是新的Git仓库，所有文件都将被添加"
    fi
    echo
}

# 创建适合的gitignore
create_gitignore_if_needed() {
    if [ -f ".gitignore" ]; then
        if [ "$IS_UPDATE" = true ]; then
            print_update "使用现有 .gitignore 文件"
        else
            print_info "检测到现有 .gitignore 文件"
        fi
        return
    fi
    
    print_info "创建 .gitignore 文件..."
    
    # 根据项目内容智能创建gitignore
    local gitignore_content="# Common files to ignore
*.log
*.tmp
*.temp
*~
.DS_Store
Thumbs.db

# IDE and editor files
.vscode/
.idea/
*.swp
*.swo
*~

"

    # 检测项目类型并添加相应的gitignore规则
    if [ -f "package.json" ] || [ -d "node_modules" ]; then
        gitignore_content+="# Node.js
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.env
.env.local
.env.production
dist/
build/

"
    fi
    
    if [ -f "requirements.txt" ] || [ -f "setup.py" ] || [ -f "pyproject.toml" ] || [ -f "*.py" 2>/dev/null ]; then
        gitignore_content+="# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
env/
venv/
.venv/
pip-log.txt
pip-delete-this-directory.txt
.pytest_cache/

"
    fi
    
    if [ -f "go.mod" ]; then
        gitignore_content+="# Go
*.exe
*.exe~
*.dll
*.so
*.dylib
*.test
*.out
vendor/

"
    fi
    
    if [ -f "Cargo.toml" ]; then
        gitignore_content+="# Rust
target/
Cargo.lock

"
    fi
    
    if [ -f "*.java" 2>/dev/null ] || [ -f "pom.xml" ] || [ -f "build.gradle" ]; then
        gitignore_content+="# Java
*.class
*.jar
*.war
*.ear
target/
build/

"
    fi
    
    echo "$gitignore_content" > .gitignore
    print_success "已创建项目专用的 .gitignore 文件"
}

# 检查远程仓库连接
check_remote_connection() {
    if [ "$IS_UPDATE" = true ] && [ -n "$REPO_URL" ]; then
        print_update "测试远程仓库连接..."
        if git ls-remote origin &> /dev/null; then
            print_success "远程仓库连接正常"
        else
            print_warning "无法连接到远程仓库，可能需要身份验证"
        fi
    fi
}

# 主要发布流程
publish_to_github() {
    if [ "$IS_UPDATE" = true ]; then
        print_update "开始推送 '$PROJECT_NAME' 的更新到Github..."
    else
        print_info "开始发布 '$PROJECT_NAME' 到Github..."
    fi
    
    # 显示当前状态
    show_status
    
    # 询问是否继续
    echo
    if [ "$IS_UPDATE" = true ]; then
        echo -n "即将提交并推送更新到Github，是否继续? (y/N): "
    else
        echo -n "即将提交并推送项目到Github，是否继续? (y/N): "
    fi
    
    read CONFIRM
    
    if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
        print_info "操作已取消"
        exit 0
    fi
    
    # 添加所有文件
    if [ "$IS_UPDATE" = true ]; then
        print_update "添加变更到暂存区..."
    else
        print_info "添加文件到暂存区..."
    fi
    git add .
    
    # 显示将要提交的文件
    print_info "将要提交的文件:"
    git diff --cached --name-only | head -20
    local cached_count=$(git diff --cached --name-only | wc -l)
    if [ $cached_count -gt 20 ]; then
        echo "... (还有 $((cached_count - 20)) 个文件)"
    fi
    echo
    
    # 提交
    if [ "$IS_UPDATE" = true ]; then
        print_update "提交更新..."
    else
        print_info "提交代码..."
    fi
    git commit -m "$COMMIT_MSG"
    
    # 创建标签（在提交之后）
    create_git_tag
    
    # 获取当前分支名
    BRANCH=$(git branch --show-current)
    if [ -z "$BRANCH" ]; then
        BRANCH="main"
        git checkout -b main
    fi
    
    # 推送到Github
    if [ "$IS_UPDATE" = true ]; then
        print_update "推送更新到Github ($BRANCH 分支)..."
        
        # 对于更新，先尝试pull，然后push
        if git pull origin "$BRANCH" --rebase 2>/dev/null; then
            print_update "已同步远程更改"
        fi
        
        if git push origin "$BRANCH"; then
            print_success "更新已成功推送到Github!"
            
            # 推送标签
            push_tags
        else
            print_error "推送更新失败"
            exit 1
        fi
    else
        print_info "推送到Github ($BRANCH 分支)..."
        
        # 首次推送需要设置upstream
        if git push -u origin "$BRANCH" 2>/dev/null; then
            print_success "项目已成功推送到Github!"
            
            # 推送标签
            push_tags
        else
            # 如果失败，可能需要处理冲突
            print_warning "推送失败，尝试处理..."
            if git pull origin "$BRANCH" --rebase 2>/dev/null; then
                git push origin "$BRANCH"
                print_success "项目已成功推送到Github!"
                
                # 推送标签
                push_tags
            else
                print_error "推送失败，可能需要手动解决冲突"
                exit 1
            fi
        fi
    fi
    
    # 显示结果
    echo
    if [ "$IS_UPDATE" = true ]; then
        print_success "🚀 项目 '$PROJECT_NAME' 更新完成!"
    else
        print_success "🎉 项目 '$PROJECT_NAME' 发布完成!"
    fi
    
    print_info "📁 本地路径: $PROJECT_DIR"
    print_info "🌐 仓库地址: $REPO_URL"
    print_info "🌿 分支: $BRANCH"
    print_info "💬 提交信息: $COMMIT_MSG"
    
    # 显示标签信息
    if [ "$CREATE_TAG" = true ] && [ -n "$NEW_TAG" ]; then
        print_tag "🏷️  新标签: $NEW_TAG"
        if [ -n "$TAG_MESSAGE" ]; then
            print_tag "📝 标签描述: $TAG_MESSAGE"
        fi
    fi
    
    # 显示作者信息
    local final_name=$(git config user.name)
    local final_email=$(git config user.email)
    print_info "👤 作者: $final_name <$final_email>"
    
    # 生成Github页面URL
    if [[ "$REPO_URL" =~ github\.com[:/]([^/]+)/([^/]+) ]]; then
        local user="${BASH_REMATCH[1]}"
        local repo="${BASH_REMATCH[2]}"
        repo="${repo%.git}"
        local github_url="https://github.com/$user/$repo"
        print_info "🔗 Github页面: $github_url"
        
        if [ "$IS_UPDATE" = true ]; then
            print_info "📊 提交历史: $github_url/commits/$BRANCH"
        fi
        
        # 显示标签和发布信息
        if [ "$CREATE_TAG" = true ] && [ -n "$NEW_TAG" ]; then
            print_tag "🚀 发布页面: $github_url/releases/tag/$NEW_TAG"
            print_tag "📋 所有版本: $github_url/releases"
        fi
    fi
}

# 错误处理和清理
cleanup() {
    if [ -n "$ORIGINAL_DIR" ] && [ -d "$ORIGINAL_DIR" ]; then
        restore_original_dir
    fi
}

# 主函数
main() {
    echo "============================================"
    echo "  完全交互式Github发布工具 + 版本管理"
    echo "============================================"
    echo
    
    # 解析参数
    parse_arguments "$@"
    
    # 验证目录
    validate_directory
    
    # 切换到项目目录
    change_to_project_dir
    
    # 检查环境
    check_git
    
    # 检测现有仓库
    detect_existing_repo
    
    # 初始化git（如果需要）
    init_git_if_needed
    
    # 设置Git用户信息
    setup_git_user
    
    # 创建gitignore（如果需要）
    create_gitignore_if_needed
    
    # 获取Github仓库
    get_github_repo
    
    # 检查远程连接
    check_remote_connection
    
    # 同步远程标签（如果是更新）
    sync_remote_tags
    
    # 显示版本状态
    show_version_status
    
    # 获取提交信息
    get_commit_message
    
    # 选择版本标签（如果需要）
    if [ "$IS_UPDATE" = true ]; then
        # 对于更新，使用当前最新标签或远程标签作为基础
        local base_tag="$CURRENT_TAG"
        if [ -z "$base_tag" ] && [ -n "$REMOTE_TAG" ]; then
            base_tag="$REMOTE_TAG"
        fi
        select_version_increment "$base_tag"
    else
        # 对于新项目，从0.0.1开始
        select_version_increment ""
    fi
    
    # 检查是否有文件可以提交
    if ! check_working_directory; then
        restore_original_dir
        exit 0
    fi
    
    # 发布或更新
    publish_to_github
    
    # 恢复原始目录
    restore_original_dir
}

# 设置错误处理和清理
trap 'print_error "脚本执行失败"; cleanup; exit 1' ERR
trap 'cleanup' EXIT

# 执行主函数
main "$@"