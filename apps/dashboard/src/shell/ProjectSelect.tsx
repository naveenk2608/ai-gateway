import { FolderKanban } from 'lucide-react';
import type { Me } from '../api.js';

/** The project every page shows, with the viewer's role in it. */
export function ProjectSelect({
  projects,
  value,
  onChange,
}: {
  projects: Me['projects'];
  value: string;
  onChange: (projectId: string) => void;
}) {
  const role = projects.find((p) => p.id === value)?.role;
  return (
    <div className="project-select">
      <FolderKanban size={16} aria-hidden="true" />
      <select aria-label="Project" value={value} onChange={(e) => onChange(e.target.value)}>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {role && (
        <span
          className={role === 'viewer' ? 'badge' : 'badge tone-accent'}
          title={role === 'viewer' ? 'You can read this project but not change it' : undefined}
        >
          {role}
        </span>
      )}
    </div>
  );
}
