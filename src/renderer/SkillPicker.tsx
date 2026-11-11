import { Description, Dropdown, Label } from '@heroui/react';
import { MagicWand01Icon } from '@hugeicons-pro/core-stroke-rounded';
import type { WorkspaceSkill } from '../shared/skills';
import { ActionButton, Icon } from './ui';

/**
 * Workspace and global Skills attached to the next task. It stays one toolbar button however
 * many Skills are installed; the list lives in its menu.
 */
export function SkillPicker({
  skills,
  selected,
  full,
  disabled,
  onChange,
}: {
  skills: WorkspaceSkill[];
  selected: string[];
  /** No further Skill can be added to this task. */
  full: boolean;
  disabled: boolean;
  onChange: (names: string[]) => void;
}) {
  const usable = skills.filter((skill) => skill.availability === 'usable');
  if (!usable.length) return null;
  const label = selected.length ? `任务 Skill：${selected.join('、')}` : '选择任务 Skill';
  return (
    <Dropdown>
      <ActionButton
        className="skill-picker"
        variant="ghost"
        size="md"
        aria-label={label}
        title={label}
        isDisabled={disabled}
      >
        <Icon icon={MagicWand01Icon} size={16} />
        {selected.length > 0 && <span className="skill-picker-count">{selected.length}</span>}
      </ActionButton>
      <Dropdown.Popover placement="top start" className="skill-menu" maxHeight={320}>
        <Dropdown.Menu
          aria-label="任务 Skill"
          selectionMode="multiple"
          selectedKeys={new Set(selected)}
          disabledKeys={
            full ? usable.map((skill) => skill.name).filter((name) => !selected.includes(name)) : []
          }
          onSelectionChange={(keys) =>
            onChange(
              usable.map((skill) => skill.name).filter((name) => keys === 'all' || keys.has(name)),
            )
          }
        >
          {usable.map((skill) => (
            <Dropdown.Item key={skill.name} id={skill.name} textValue={skill.name}>
              <div className="skill-option-copy">
                <Label>{skill.name}</Label>
                <Description>{skill.description}</Description>
              </div>
              <Dropdown.ItemIndicator />
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
