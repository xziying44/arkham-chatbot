import { useEffect, useState } from "react";
import { Typography, Card, Tag, Spin, Alert, List, Tabs, Empty, Space } from "antd";
import { api } from "../api/client";
import type { SkillSummary, SkillDetail } from "../api/types";

/**
 * 技能查看页（只读）。
 *
 * 左侧：所有已加载技能的列表（name + description）。
 * 右侧：选中技能的详情——SKILL.md 正文 + 附件文件（tab 切换）。
 *
 * 技能源文件在仓库内 skills/ 目录（git 管理），这里只提供查看，不支持在线编辑。
 */
export default function Skills() {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedName, setSelectedName] = useState<string | undefined>();
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    api
      .listSkills()
      .then((r) => {
        setSkills(r.items);
        if (r.items.length > 0) setSelectedName(r.items[0].name);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedName) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    api
      .getSkill(selectedName)
      .then(setDetail)
      .finally(() => setDetailLoading(false));
  }, [selectedName]);

  if (loading) return <Spin />;
  if (skills.length === 0) {
    return (
      <div>
        <Typography.Title level={4}>技能</Typography.Title>
        <Empty description="暂无已加载的技能。技能文件放在仓库 skills/ 目录下（每个子目录一个 SKILL.md）。" />
      </div>
    );
  }

  return (
    <div>
      <Typography.Title level={4}>技能</Typography.Title>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="技能（Skills）"
        description="技能以 SKILL.md 文件形式存放在仓库 skills/ 目录。启动时自动加载并注入到所有会话的系统提示词——当用户的请求匹配技能描述时，智能体会读取技能说明并按步骤执行。技能文件是 git 管理的源文件，请在编辑器里修改后提交。"
      />

      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Card title="技能列表" size="small">
          <List
            dataSource={skills}
            rowKey="name"
            renderItem={(s) => (
              <List.Item
                style={{
                  cursor: "pointer",
                  background: selectedName === s.name ? "#e6f4ff" : undefined,
                  padding: "8px 12px",
                  borderRadius: 4,
                }}
                onClick={() => setSelectedName(s.name)}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Typography.Text strong>{s.name}</Typography.Text>
                      <Tag>{s.files.length} 个文件</Tag>
                    </Space>
                  }
                  description={s.description}
                />
              </List.Item>
            )}
          />
        </Card>

        {selectedName && (
          <Card title={`技能详情：${selectedName}`} size="small">
            {detailLoading ? (
              <Spin />
            ) : detail ? (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Tag color="blue">{detail.filePath}</Tag>
                  {detail.attachments.length > 0 && (
                    <Tag color="green">{detail.attachments.length} 个附件</Tag>
                  )}
                </Space>
                <Tabs
                  defaultActiveKey="skill"
                  items={[
                    {
                      key: "skill",
                      label: "SKILL.md",
                      children: (
                        <pre
                          style={{
                            whiteSpace: "pre-wrap",
                            fontSize: 13,
                            lineHeight: 1.6,
                            margin: 0,
                            maxHeight: 600,
                            overflow: "auto",
                          }}
                        >
                          {detail.content}
                        </pre>
                      ),
                    },
                    ...detail.attachments.map((a) => ({
                      key: a.path,
                      label: a.path,
                      children: (
                        <pre
                          style={{
                            whiteSpace: "pre-wrap",
                            fontSize: 13,
                            lineHeight: 1.6,
                            margin: 0,
                            maxHeight: 600,
                            overflow: "auto",
                          }}
                        >
                          {a.content}
                        </pre>
                      ),
                    })),
                  ]}
                />
              </>
            ) : (
              <Alert type="error" message="加载失败" />
            )}
          </Card>
        )}
      </Space>
    </div>
  );
}
