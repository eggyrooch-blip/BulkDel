import './App.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  bitable,
  FieldType,
  IFieldMeta,
  ITableMeta,
} from '@lark-base-open/js-sdk';
import {
  Button,
  Checkbox,
  Empty,
  Input,
  Modal,
  Popconfirm,
  Select,
  Spin,
  Tag,
  Toast,
  Tooltip,
  Typography,
} from '@douyinfe/semi-ui';
import {
  IconCamera,
  IconClose,
  IconDeleteStroked,
  IconRefresh,
  IconSearch,
  IconUndo,
} from '@douyinfe/semi-icons';

type TableBundle = {
  meta: ITableMeta;
  fields: IFieldMeta[];
};

type SnapshotField = {
  id: string;
  name: string;
  type: FieldType;
  property?: unknown;
};

type SnapshotTable = {
  tableId: string;
  tableName: string;
  fields: SnapshotField[];
};

type Snapshot = {
  label: string;
  timestamp: string;
  tables: SnapshotTable[];
};

type RenderBundle = {
  bundle: TableBundle;
  visibleFields: IFieldMeta[];
  tableMatches: boolean;
  shouldDisplay: boolean;
};

type ThemeModeType = 'LIGHT' | 'DARK';
type FieldSortMode = 'structure' | 'modified-desc';

const LOCAL_STORAGE_KEY = 'boom-table-shredder-snapshot';
const BRIDGE_SNAPSHOT_KEY = 'boom.table-shredder.snapshot.v1';

const BLOCKED_ROLLBACK_FIELD_TYPES: FieldType[] = [
  FieldType.CreatedTime,
  FieldType.ModifiedTime,
  FieldType.CreatedUser,
  FieldType.ModifiedUser,
  FieldType.AutoNumber,
];

const NON_PORTABLE_ROLLBACK_FIELD_TYPES: Set<FieldType> = new Set([
  FieldType.Lookup,
  FieldType.SingleLink,
  FieldType.DuplexLink,
  FieldType.Formula,
  FieldType.Barcode,
]);

const fieldTypeDictionary = FieldType as unknown as Record<number, string>;

const cloneJson = <T,>(value: T | undefined): T | undefined => {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    console.warn('Failed to clone field property', error);
    return value;
  }
};

const loadPersistedSnapshot = (): Snapshot | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as Snapshot;
  } catch (error) {
    console.error('读取快照缓存失败', error);
    return null;
  }
};

const persistSnapshot = (snapshot: Snapshot | null) => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    if (!snapshot) {
      window.localStorage.removeItem(LOCAL_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.error('写入快照缓存失败', error);
  }
};

const formatTimestamp = (input: string) => {
  try {
    return new Date(input).toLocaleString();
  } catch {
    return input;
  }
};

const parseDateLikeValue = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return value;
    }
    if (value > 1_000_000_000) {
      return value * 1000;
    }
    if (value > 0) {
      return value;
    }
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 0;
};

const getFieldModifiedTime = (field: IFieldMeta): number => {
  const property = field.property as Record<string, unknown> | undefined;
  const candidates: unknown[] = [
    (field as unknown as Record<string, unknown>).modifiedTime,
    (field as unknown as Record<string, unknown>).modified_time,
    (field as unknown as Record<string, unknown>).updateTime,
    (field as unknown as Record<string, unknown>).update_time,
    (field as unknown as Record<string, unknown>).updatedAt,
    (field as unknown as Record<string, unknown>).updated_at,
    property?.modifiedTime,
    property?.modified_time,
    property?.updateTime,
    property?.update_time,
    property?.updatedAt,
    property?.updated_at,
    property?.lastModifiedTime,
    property?.last_modified_time,
    property?.lastModifyTime,
    property?.last_modify_time,
    property?.lastEditedTime,
    property?.last_edited_time,
  ];
  for (const candidate of candidates) {
    const timestamp = parseDateLikeValue(candidate);
    if (timestamp > 0) {
      return timestamp;
    }
  }
  return 0;
};

export default function App() {
  const snapshotRef = useRef<Snapshot | null>(null);
  const [theme, setTheme] = useState<ThemeModeType>('DARK');
  const [loading, setLoading] = useState(true);
  const [tables, setTables] = useState<TableBundle[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedTables, setSelectedTables] = useState<Record<string, boolean>>(
    {},
  );
  const [selectedFields, setSelectedFields] = useState<
    Record<string, Record<string, boolean>>
  >({});
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [tableQuery, setTableQuery] = useState('');
  const [fieldTypeFilter, setFieldTypeFilter] = useState<string>('all');
  const [fieldSortMode, setFieldSortMode] = useState<FieldSortMode>('structure');
  const [selectionVersion, setSelectionVersion] = useState(0);
  const [snapshotDrawerVisible, setSnapshotDrawerVisible] = useState(false);
  const [deletePanelOpen, setDeletePanelOpen] = useState(false);

  const selectedTableCount = useMemo(
    () => Object.values(selectedTables).filter(Boolean).length,
    [selectedTables],
  );

  const selectedFieldCount = useMemo(
    () =>
      Object.values(selectedFields).reduce((sum, tableSelection) => {
        return (
          sum + Object.values(tableSelection).filter(Boolean).length
        );
      }, 0),
    [selectedFields],
  );

  const totalSelectedTargets = selectedTableCount + selectedFieldCount;

  useEffect(() => {
    const bridge = bitable?.bridge as any;
    let off: (() => void) | undefined;

    const initTheme = async () => {
      if (bridge && typeof bridge.getTheme === 'function') {
        try {
          const current = await bridge.getTheme();
          if (current === 'LIGHT' || current === 'DARK') {
            setTheme(current);
          }
        } catch (error) {
          console.warn('获取主题失败', error);
        }
      }
      if (bridge && typeof bridge.onThemeChange === 'function') {
        try {
          off = bridge.onThemeChange((event: any) => {
            const next = event?.data?.theme;
            if (next === 'LIGHT' || next === 'DARK') {
              setTheme(next);
            }
          });
        } catch (error) {
          console.warn('注册主题监听失败', error);
        }
      }
    };

    initTheme();

    return () => {
      off?.();
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const classList = document.body.classList;
    classList.remove('theme-light', 'theme-dark');
    classList.add(theme === 'LIGHT' ? 'theme-light' : 'theme-dark');
    return () => {
      classList.remove('theme-light', 'theme-dark');
    };
  }, [theme]);

  const refreshTables = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const metaList = await bitable.base.getTableMetaList();
      const bundles = await Promise.all(
        metaList.map(async (meta: ITableMeta): Promise<TableBundle> => {
          const table = await bitable.base.getTableById(meta.id);
          const fieldMetaList = await table.getFieldMetaList();
          return {
            meta,
            fields: fieldMetaList,
          };
        }),
      );
      setTables(bundles);
      setSelectedTables((prev) => {
        const next: Record<string, boolean> = {};
        for (const bundle of bundles) {
          if (prev[bundle.meta.id]) {
            next[bundle.meta.id] = true;
          }
        }
        return next;
      });
      setSelectedFields((prev) => {
        const next: Record<string, Record<string, boolean>> = {};
        for (const bundle of bundles) {
          if (prev[bundle.meta.id]) {
            const filtered: Record<string, boolean> = {};
            for (const field of bundle.fields) {
              if (prev[bundle.meta.id][field.id]) {
                filtered[field.id] = true;
              }
            }
            if (Object.keys(filtered).length > 0) {
              next[bundle.meta.id] = filtered;
            }
          }
        }
        return next;
      });
    } catch (error) {
      console.error(error);
      setLoadError('炸了：读取表结构失败，请刷新重试。');
      Toast.error('加载表信息失败，先别拔电源，刷新试试。');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshTables();
  }, [refreshTables]);

  useEffect(() => {
    const bridge = bitable?.bridge as any;
    let off: (() => void) | undefined;

    const loadSnapshot = async () => {
      if (bridge && typeof bridge.getData === 'function') {
        try {
          const stored = (await bridge.getData?.(BRIDGE_SNAPSHOT_KEY)) as
            | Snapshot
            | null
            | undefined;
          if (stored) {
            setSnapshot(stored);
            Toast.info('已接管上一回快照，放心删也要慎重。');
            return;
          }
          if (stored === null) {
            setSnapshot(null);
            return;
          }
        } catch (error) {
          console.warn('读取 bridge 快照失败', error);
        }
      }
      const persisted = loadPersistedSnapshot();
      if (persisted) {
        setSnapshot(persisted);
        Toast.info('已接管上一回快照，放心删也要慎重。');
      }
    };

    const registerBridgeListener = async () => {
      if (bridge && typeof bridge.onDataChange === 'function') {
        try {
          off = bridge.onDataChange((event: any) => {
            const { key, value } = event?.data ?? {};
            if (key !== BRIDGE_SNAPSHOT_KEY) {
              return;
            }
            const incoming = (value ?? null) as Snapshot | null;
            const current = snapshotRef.current;
            const same =
              JSON.stringify(current ?? null) ===
              JSON.stringify(incoming ?? null);
            if (!same) {
              setSnapshot(incoming);
            }
          });
        } catch (error) {
          console.warn('注册 bridge 数据监听失败', error);
        }
      }
    };

    loadSnapshot();
    registerBridgeListener();

    return () => {
      off?.();
    };
  }, []);

  useEffect(() => {
    snapshotRef.current = snapshot;
    persistSnapshot(snapshot);

    const syncBridgeSnapshot = async () => {
      const bridge = bitable?.bridge as any;
      if (!bridge || typeof bridge.setData !== 'function') {
        return;
      }
      try {
        await bridge.setData?.(BRIDGE_SNAPSHOT_KEY, snapshot);
      } catch (error) {
        console.warn('写入 bridge 快照失败', error);
      }
    };

    syncBridgeSnapshot();
  }, [snapshot]);

  const availableFieldTypeOptions = useMemo(() => {
    const result = new Map<string, string>();
    for (const bundle of tables) {
      for (const field of bundle.fields) {
        const key = String(field.type);
        if (!result.has(key)) {
          result.set(
            key,
            fieldTypeDictionary[field.type] ?? `类型 ${field.type}`,
          );
        }
      }
    }
    return Array.from(result.entries()).map(([value, label]) => ({
      value,
      label,
    }));
  }, [tables]);

  const renderBundles = useMemo<RenderBundle[]>(() => {
    const normalizedQuery = tableQuery.trim().toLowerCase();
    const sortFields = (fields: IFieldMeta[]): IFieldMeta[] => {
      if (fieldSortMode === 'structure') {
        return fields;
      }
      return [...fields].sort(
        (a, b) => getFieldModifiedTime(b) - getFieldModifiedTime(a),
      );
    };
    return tables
      .map((bundle) => {
        const tableName = bundle.meta.name ?? '无名表';
        const tableMatches =
          normalizedQuery.length === 0
            ? true
            : tableName.toLowerCase().includes(normalizedQuery);
        const baseFields = bundle.fields.filter((field) => {
          if (
            fieldTypeFilter !== 'all' &&
            String(field.type) !== fieldTypeFilter
          ) {
            return false;
          }
          if (normalizedQuery.length === 0) {
            return true;
          }
          if (tableMatches) {
            return true;
          }
          const fieldName = field.name ?? '无名字段';
          return fieldName.toLowerCase().includes(normalizedQuery);
        });
        const visibleFields = sortFields(baseFields);
        const shouldDisplay = tableMatches || baseFields.length > 0;
        return {
          bundle,
          visibleFields,
          tableMatches,
          shouldDisplay,
        };
      })
      .filter((item) => item.shouldDisplay);
  }, [tables, tableQuery, fieldTypeFilter, fieldSortMode]);

  const toggleTable = useCallback((tableId: string) => {
    setSelectedTables((prev) => {
      const next = { ...prev };
      if (next[tableId]) {
        delete next[tableId];
      } else {
        next[tableId] = true;
      }
      return next;
    });
  }, []);

  const toggleField = useCallback((tableId: string, fieldId: string) => {
    setSelectedFields((prev) => {
      const tableSelection = { ...(prev[tableId] ?? {}) };
      if (tableSelection[fieldId]) {
        delete tableSelection[fieldId];
      } else {
        tableSelection[fieldId] = true;
      }
      const next = { ...prev };
      if (Object.keys(tableSelection).length === 0) {
        delete next[tableId];
      } else {
        next[tableId] = tableSelection;
      }
      return next;
    });
  }, []);

  const captureSnapshot = useCallback(
    async (label: string): Promise<boolean> => {
      setSnapshotBusy(true);
      try {
        const metaList = await bitable.base.getTableMetaList();
        const tablesWithFields = await Promise.all(
          metaList.map(async (meta) => {
            const table = await bitable.base.getTableById(meta.id);
            const fieldMetaList = await table.getFieldMetaList();
            return {
              tableId: meta.id,
              tableName: meta.name ?? '无名表',
              fields: fieldMetaList.map((field) => ({
                id: field.id,
                name: field.name ?? '无名字段',
                type: field.type,
                property: cloneJson(field.property),
              })),
            };
          }),
        );
        const snap: Snapshot = {
          label,
          timestamp: new Date().toISOString(),
          tables: tablesWithFields,
        };
        setSnapshot(snap);
        Toast.success('快照搞定，随时反悔。');
        return true;
      } catch (error) {
        console.error(error);
        Toast.error('快照失败，数据还没删，冷静再试一次。');
        return false;
      } finally {
        setSnapshotBusy(false);
      }
    },
    [],
  );

  const performDeletion = useCallback(async () => {
    const errors: string[] = [];
    
    // 获取当前所有表的列表
    const currentTableList = await bitable.base.getTableMetaList();
    const currentTableIds = currentTableList.map(meta => meta.id);
    
    // 计算要删除的表
    let tableIdsToDelete = Object.entries(selectedTables)
      .filter(([, checked]) => checked)
      .map(([tableId]) => tableId);
    
    // 判断是否会删除所有表（多维表格必须保留至少一张表）
    const willDeleteAllTables = tableIdsToDelete.length >= currentTableIds.length;
    let lastTableId: string | null = null;
    let lastTableName: string | null = null;
    
    if (willDeleteAllTables && currentTableIds.length > 0) {
      // 保留最后一张表（列表中的最后一个）
      lastTableId = currentTableIds[currentTableIds.length - 1];
      lastTableName = currentTableList[currentTableIds.length - 1].name || '未知表';
      // 从删除列表中排除最后一张表
      tableIdsToDelete = tableIdsToDelete.filter(id => id !== lastTableId);
      Toast.info(`多维表格必须保留至少一张表，将保留表 "${lastTableName}"，仅删除其字段（索引列除外）`);
    }
    
    // 第一步：删除选中的表（排除最后一张表，删除表会自动删除表内所有字段）
    for (const tableId of tableIdsToDelete) {
      try {
        await bitable.base.deleteTable(tableId);
      } catch (error) {
        console.error(error);
        errors.push(`表 ${tableId} 删除失败`);
      }
    }

    // 第二步：删除选中表的字段（跳过已删除的表，因为删除表会自动删除所有字段）
    for (const [tableId, fieldMap] of Object.entries(selectedFields)) {
      // 如果表已被删除（且不是最后一张表），跳过该表的字段删除
      // 如果最后一张表在 selectedTables 中，跳过这里的处理，在第三步单独处理
      if (selectedTables[tableId] && tableId !== lastTableId) {
        continue;
      }
      // 如果最后一张表在 selectedTables 中，跳过这里的字段删除，在第三步统一处理
      if (tableId === lastTableId && selectedTables[lastTableId]) {
        continue;
      }
      
      const fieldIds = Object.entries(fieldMap)
        .filter(([, checked]) => checked)
        .map(([fieldId]) => fieldId);
      if (fieldIds.length === 0) {
        continue;
      }
      
      try {
        const table = await bitable.base.getTableById(tableId);
        const fieldMetaList = await table.getFieldMetaList();
        const fieldMetaMap = new Map(fieldMetaList.map(f => [f.id, f]));
        
        // 如果是最后一张表（但不在 selectedTables 中），需要排除索引列
        const fieldsToDelete = tableId === lastTableId
          ? fieldIds.filter(fieldId => {
              const fieldMeta = fieldMetaMap.get(fieldId);
              return fieldMeta && fieldMeta.isPrimary !== true;
            })
          : fieldIds;
        
        if (fieldsToDelete.length === 0) {
          if (tableId === lastTableId) {
            Toast.info(`表 "${lastTableName}" 的索引列已自动排除，无其他字段可删除`);
          }
          continue;
        }
        
        for (const fieldId of fieldsToDelete) {
          try {
            await table.deleteField(fieldId);
          } catch (error) {
            console.error(error);
            errors.push(`字段 ${fieldId} 删除失败`);
          }
        }
      } catch (error) {
        console.error(error);
        errors.push(`无法加载表 ${tableId}，字段没有删除`);
      }
    }
    
    // 第三步：如果最后一张表被选中，删除其所有非索引字段
    if (lastTableId && selectedTables[lastTableId]) {
      try {
        const table = await bitable.base.getTableById(lastTableId);
        const fieldMetaList = await table.getFieldMetaList();
        // 获取所有非索引列字段
        const nonIndexFields = fieldMetaList.filter(f => f.isPrimary !== true);
        
        if (nonIndexFields.length > 0) {
          for (const field of nonIndexFields) {
            try {
              await table.deleteField(field.id);
            } catch (error) {
              console.error(error);
              errors.push(`字段 ${field.name || field.id} 删除失败`);
            }
          }
        } else {
          Toast.info(`表 "${lastTableName}" 仅包含索引列，无其他字段可删除`);
        }
      } catch (error) {
        console.error(error);
        errors.push(`无法处理最后一张表的字段删除`);
      }
    }

    if (errors.length > 0) {
      Toast.warning(`部分操作失败：${errors.join(' / ')}`);
    } else {
      Toast.success('轰隆一声，选中的表与字段已经清理。');
    }

    setSelectedTables({});
    setSelectedFields({});
    await refreshTables();
  }, [selectedTables, selectedFields, refreshTables]);

  const handleDelete = useCallback(async () => {
    if (totalSelectedTargets === 0) {
      Toast.info('先勾选要挥刀的目标，再点删除。');
      return;
    }
    setDeleteBusy(true);
    const snapshotOk = await captureSnapshot('删除前自动快照');
    if (!snapshotOk) {
      setDeleteBusy(false);
      Modal.confirm({
        title: '快照失败，要冒险继续删除吗？',
        content: (
          <div className="confirm-content">
            <p>· 删除操作不可逆，且当前没有新快照。</p>
            <p>· 请确保：已备份 / 身处沙箱 / 明白后果。</p>
            <p>
              · 本次目标：{selectedTableCount} 张表，
              {selectedFieldCount} 个字段。
            </p>
          </div>
        ),
        width: 420,
        okText: '确认删除',
        cancelText: '我再想想',
        onOk: async () => {
          setDeleteBusy(true);
          try {
            await performDeletion();
          } finally {
            setDeleteBusy(false);
          }
        },
      });
      return;
    }
    try {
      await performDeletion();
    } finally {
      setDeleteBusy(false);
    }
  }, [
    totalSelectedTargets,
    captureSnapshot,
    performDeletion,
    selectedTableCount,
    selectedFieldCount,
  ]);

  const handleRollback = useCallback(async () => {
    if (!snapshot) {
      Toast.info('没有快照可回滚，先截个快照吧。');
      return;
    }
    setRollbackBusy(true);
    const errors: string[] = [];
    try {
      const existingTableMetaList = await bitable.base.getTableMetaList();
      const existingTableNames = new Set<string>(
        existingTableMetaList.map((meta) => meta.name ?? ''),
      );
      for (const tableSnap of snapshot.tables) {
        let rollbackTableName = `♻️ ${tableSnap.tableName}`;
        try {
          const baseRollbackName = rollbackTableName;
          let suffix = 1;
          while (existingTableNames.has(rollbackTableName)) {
            rollbackTableName = `${baseRollbackName} (${suffix})`;
            suffix += 1;
          }

          const { tableId } = await bitable.base.addTable({
            name: rollbackTableName,
            fields: [],
          });
          existingTableNames.add(rollbackTableName);

          const table = await bitable.base.getTableById(tableId);

          try {
            const currentFieldMetas = await table.getFieldMetaList();
            const primaryField = currentFieldMetas.find(
              (field: IFieldMeta) => field.isPrimary,
            );
            if (primaryField) {
              const safePrimaryName = primaryField.name?.includes('(系统默认)')
                ? primaryField.name
                : `${primaryField.name || '主键'} (系统默认)`;
              if (safePrimaryName !== primaryField.name) {
                await table.setField(primaryField.id, { name: safePrimaryName });
              }
            }
          } catch (error) {
            console.error(error);
            errors.push(`表 ${rollbackTableName} 主键重命名失败`);
          }

          for (const field of tableSnap.fields) {
            if (BLOCKED_ROLLBACK_FIELD_TYPES.includes(field.type)) {
              errors.push(
                `跳过系统字段 ${field.name}（类型 ${
                  fieldTypeDictionary[field.type] ?? field.type
                }）`,
              );
              continue;
            }
            if (NON_PORTABLE_ROLLBACK_FIELD_TYPES.has(field.type)) {
              errors.push(
                `复杂字段 ${field.name}（类型 ${
                  fieldTypeDictionary[field.type] ?? field.type
                }）暂不支持回滚`,
              );
              continue;
            }
            try {
              const addFieldConfig = {
                type: field.type,
                name: field.name,
                property: field.property,
              } as any;
              await table.addField(addFieldConfig);
            } catch (error) {
              console.error(error);
              errors.push(
                `字段 ${field.name} 重建失败（表 ${rollbackTableName}）`,
              );
            }
          }
        } catch (error) {
          console.error(error);
          errors.push(`表 ${rollbackTableName} 重建失败`);
        }
      }
      if (errors.length > 0) {
        Toast.warning(`回滚部分成功：${errors.join(' / ')}`);
      } else {
        Toast.success('快照回滚完成，误删的结构已复活。');
      }
      await refreshTables();
    } finally {
      setRollbackBusy(false);
    }
  }, [snapshot, refreshTables]);

  const manualSnapshot = useCallback(async () => {
    await captureSnapshot('手动快照');
  }, [captureSnapshot]);

  const selectVisibleTables = useCallback(() => {
    if (renderBundles.length === 0) {
      Toast.info('当前筛选没有表可以选择。');
      return;
    }
    const next: Record<string, boolean> = {};
    for (const { bundle } of renderBundles) {
      next[bundle.meta.id] = true;
    }
    setSelectedTables(next);
    setSelectedFields({});
    Toast.success('已选中所有筛选内的表。');
  }, [renderBundles]);

  const selectVisibleFields = useCallback(() => {
    if (renderBundles.length === 0) {
      Toast.info('当前筛选没有字段可以选择。');
      return;
    }
    const next: Record<string, Record<string, boolean>> = {};
    for (const { bundle, visibleFields } of renderBundles) {
      if (selectedTables[bundle.meta.id]) {
        continue;
      }
      if (visibleFields.length === 0) {
        continue;
      }
      next[bundle.meta.id] = {};
      for (const field of visibleFields) {
        next[bundle.meta.id][field.id] = true;
      }
    }
    setSelectedFields(next);
    Toast.success('已选中当前筛选的字段。');
  }, [renderBundles, selectedTables]);

  const clearSelections = useCallback(() => {
    setSelectedTables(() => ({}));
    setSelectedFields(() => ({}));
    setTableQuery('');
    setFieldTypeFilter('all');
    setFieldSortMode('structure');
    setSelectionVersion((prev) => prev + 1);
    Toast.info('选择已清空。');
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <Typography.Title heading={3} className="app-title">
          批量删字段 · BulkDel
        </Typography.Title>
        <div className="app-subtitle">
          <Typography.Text type="tertiary" strong>
            批量删除，一键清空数据
          </Typography.Text>
          <Typography.Text type="tertiary" style={{ display: 'block', marginTop: '4px' }}>
            此插件可快速删除大量数据。建议删除前先备份当前版本，确保数据可恢复。
          </Typography.Text>
        </div>
      </header>

      <div className="danger-banner">
        <div className="danger-content">
          <div className="danger-title">⚠️ 重要提示：</div>
          <div className="danger-body">
            <p>删除操作立即生效，请谨慎使用</p>
            <p>飞书多维表格支持「历史版本」恢复，可在操作后回溯完整数据（包括记录内容）</p>
            <p>建议删除前：确认操作权限，明确责任人，必要时手动备份关键数据</p>
          </div>
        </div>
      </div>

      <section className="filters">
        <div className="filters-inputs">
          <Input
            prefix={<IconSearch />}
            placeholder="按表名 / 字段名检索"
            value={tableQuery}
            onChange={(value) => setTableQuery(value)}
          />
          <Select
            placeholder="字段类型过滤"
            value={fieldTypeFilter === 'all' ? undefined : fieldTypeFilter}
            onChange={(value) =>
              setFieldTypeFilter(
                typeof value === 'string' && value.length > 0 ? value : 'all',
              )
            }
            style={{ minWidth: 220 }}
            optionList={availableFieldTypeOptions}
          />
        </div>
        <div className="filters-actions">
          <Select
            className="filters-sort"
            value={fieldSortMode}
            onChange={(value) => {
              if (value === 'structure' || value === 'modified-desc') {
                setFieldSortMode(value);
              }
            }}
            style={{ minWidth: 220 }}
            optionList={[
              { value: 'structure', label: '按表结构排序' },
              { value: 'modified-desc', label: '按最近修改排序' },
            ]}
          />
          <Button theme="light" onClick={selectVisibleTables}>
            全选表
          </Button>
          <Button theme="light" onClick={selectVisibleFields}>
            全选字段
          </Button>
          <Button 
            theme="borderless" 
            type="danger" 
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              clearSelections();
            }}
          >
            清空选择
          </Button>
        </div>
      </section>

      {/* 悬浮磁吸快照按钮 */}
      <div className="snapshot-fab">
        <Tooltip content={snapshot ? '查看快照信息' : '操作前自动快照'}>
          <Button
            type={snapshot ? 'primary' : 'tertiary'}
            theme="solid"
            icon={<IconCamera />}
            onClick={() => setSnapshotDrawerVisible(true)}
            className="snapshot-fab-button"
            style={{
              width: '56px',
              height: '56px',
              borderRadius: '50%',
              boxShadow: snapshot
                ? '0 4px 12px rgba(34, 197, 94, 0.4)'
                : '0 4px 12px rgba(148, 163, 184, 0.3)',
            }}
          >
            {snapshot && (
              <span className="snapshot-fab-badge" />
            )}
          </Button>
        </Tooltip>
      </div>

      {/* 快照侧边栏面板 */}
      {snapshotDrawerVisible && (
        <>
          <div 
            className="snapshot-overlay"
            onClick={() => setSnapshotDrawerVisible(false)}
          />
          <div className="snapshot-drawer">
            <div className="snapshot-drawer-header">
              <Typography.Title heading={5}>操作前自动快照</Typography.Title>
              <Button
                type="tertiary"
                theme="borderless"
                icon={<IconClose />}
                onClick={() => setSnapshotDrawerVisible(false)}
                style={{ minWidth: 'auto', padding: '4px' }}
              />
            </div>
            <div className="snapshot-drawer-content">
              <div className="snapshot-card__meta">
                <Typography.Text strong>
                  {snapshot ? '自动快照已保存' : '尚未创建快照'}
                </Typography.Text>
                <Typography.Text type="tertiary">
                  {snapshot
                    ? `快照时间：${formatTimestamp(snapshot.timestamp)}`
                    : '删除前请务必保存一次结构快照'}
                </Typography.Text>
                {snapshot && (
                  <div style={{ marginTop: '8px' }}>
                    <Typography.Text type="tertiary" style={{ display: 'block', marginBottom: '8px' }}>
                      📋 <strong>说明：</strong>本快照仅保存数据表和字段结构，不包含数据记录内容。
                    </Typography.Text>
                    <Typography.Text type="warning" style={{ display: 'block' }}>
                      💡 <strong>温馨提示：</strong>
                    </Typography.Text>
                    <ul style={{ marginTop: '4px', marginBottom: 0, paddingLeft: '20px' }}>
                      <li>如需恢复数据记录内容：进入「历史记录」→ 找到对应时间点记录 → 点击「还原此版本」，可恢复完整数据（包括记录内容）</li>
                      <li>本快照仅用于恢复表结构和字段结构，作为额外保障</li>
                    </ul>
                  </div>
                )}
              </div>
              <div className="snapshot-card__actions">
                <Tooltip content="刷新当前的表与字段清单">
                  <Button
                    icon={<IconRefresh />}
                    onClick={refreshTables}
                    loading={loading}
                    block
                  >
                    刷新
                  </Button>
                </Tooltip>
                <Tooltip content="手动保存一份结构快照，心里更踏实">
                  <Button
                    icon={<IconCamera />}
                    theme="light"
                    onClick={manualSnapshot}
                    loading={snapshotBusy}
                    block
                  >
                    记录快照
                  </Button>
                </Tooltip>
                <Tooltip content="撤销最近一次爆破（尽力而为版）">
                  <Button
                    icon={<IconUndo />}
                    theme="light"
                    onClick={handleRollback}
                    loading={rollbackBusy}
                    disabled={!snapshot || snapshotBusy}
                    block
                  >
                    快照回滚
                  </Button>
                </Tooltip>
              </div>
            </div>
          </div>
        </>
      )}

      <aside
        className={`delete-bubble ${
          deletePanelOpen ? 'delete-bubble-open' : ''
        }`}
      >
        <Tooltip
          content={
            deletePanelOpen
              ? '收起删除面板'
              : '查看删除统计并执行一键清理'
          }
          position="left"
        >
          <Button
            className="delete-bubble__trigger"
            theme="solid"
            type="danger"
            icon={<IconDeleteStroked />}
            onClick={() => setDeletePanelOpen((prev) => !prev)}
          >
            <span className="delete-bubble__count">{totalSelectedTargets}</span>
          </Button>
        </Tooltip>
        {deletePanelOpen && (
          <section className="delete-panel">
            <div className="delete-panel__header">
              <Typography.Text strong>一键清理</Typography.Text>
              <Button
                type="tertiary"
                theme="borderless"
                icon={<IconClose />}
                onClick={() => setDeletePanelOpen(false)}
                style={{ minWidth: 'auto', padding: '4px' }}
              />
            </div>
            <div className="delete-panel__body">
              <div className="delete-panel__metrics">
                <Tag size="large">已选表：{selectedTableCount}</Tag>
                <Tag size="large">已选字段：{selectedFieldCount}</Tag>
                <Tag size="large">
                  快照：{snapshot ? `已保存 · ${snapshot.label}` : '未创建'}
                </Tag>
              </div>
              <Typography.Text type="tertiary" className="delete-panel__hint">
                当前筛选：{renderBundles.length} 张表
              </Typography.Text>
            </div>
            <div className="delete-panel__actions">
              <Button theme="light" onClick={clearSelections}>
                清空选择
              </Button>
              <Popconfirm
                title="终极确认：删除所选表和字段？"
                content={
                  <div className="confirm-content">
                    <p>· 操作不可撤销，数据将瞬间蒸发。</p>
                    <p>· 请确认：备份与权限都准备妥当。</p>
                    <p>
                      · 目标：{selectedTableCount} 张表，{selectedFieldCount} 个字段。
                    </p>
                  </div>
                }
                position="left"
                onConfirm={handleDelete}
                disabled={totalSelectedTargets === 0}
              >
                <Button
                  theme="solid"
                  type="danger"
                  icon={<IconDeleteStroked />}
                  loading={deleteBusy}
                  disabled={totalSelectedTargets === 0}
                >
                  一键清理（{totalSelectedTargets}）
                </Button>
              </Popconfirm>
            </div>
          </section>
        )}
      </aside>

      <main className="table-list">
        {loading ? (
          <div className="loading">
            <Spin size="large">正在召唤全部表格…</Spin>
          </div>
        ) : loadError ? (
          <div className="loading">
            <Typography.Text type="danger">{loadError}</Typography.Text>
          </div>
        ) : renderBundles.length === 0 ? (
          <Empty description="当前筛选下没有表格，换个姿势试试。" />
        ) : (
          renderBundles.map(({ bundle, visibleFields, tableMatches }) => {
            const isTableSelected = !!selectedTables[bundle.meta.id];
            const tableFieldSelections = selectedFields[bundle.meta.id] ?? {};
            return (
              <article
                key={bundle.meta.id}
                className={`table-card ${
                  isTableSelected ? 'table-card-selected' : ''
                }`}
              >
                <header className="table-card__header">
                  <Checkbox
                    key={`table-${bundle.meta.id}-${selectionVersion}`}
                    checked={isTableSelected}
                    onChange={() => toggleTable(bundle.meta.id)}
                  >
                    <Typography.Text strong>
                      {bundle.meta.name || '无名表'}
                    </Typography.Text>
                  </Checkbox>
                  <Tag size="large">
                    字段 {bundle.fields.length}
                  </Tag>
                </header>
                <ul className="field-list">
                  {visibleFields.length === 0 ? (
                    <li className="field-item field-item-empty">
                      <Typography.Text type="tertiary">
                        {tableMatches
                          ? '该表暂无符合筛选条件的字段。'
                          : '字段不匹配搜索关键字。'}
                      </Typography.Text>
                    </li>
                  ) : (
                    visibleFields.map((field) => {
                      const isFieldSelected =
                        !!tableFieldSelections[field.id];
                      const fieldTypeName =
                        fieldTypeDictionary[field.type] ??
                        `类型 ${field.type}`;
                      const isIndexField = field.isPrimary === true;
                      const checkbox = (
                        <Checkbox
                          key={`${field.id}-${selectionVersion}`}
                          disabled={isTableSelected || isIndexField}
                          checked={isFieldSelected}
                          onChange={() =>
                            toggleField(bundle.meta.id, field.id)
                          }
                        >
                          {field.name || '无名字段'}
                        </Checkbox>
                      );
                      return (
                        <li
                          key={field.id}
                          className={`field-item ${
                            isFieldSelected ? 'field-item-selected' : ''
                          }`}
                        >
                          {isIndexField ? (
                            <Tooltip content="索引列不可删除">
                              {checkbox}
                            </Tooltip>
                          ) : (
                            checkbox
                          )}
                          <Tag size="small">
                            {fieldTypeName}
                          </Tag>
                        </li>
                      );
                    })
                  )}
                </ul>
              </article>
            );
          })
        )}
      </main>

      <footer className="app-footer">
        <Typography.Text type="tertiary">
          💡 <strong>使用建议：</strong>
        </Typography.Text>
        <ul style={{ marginTop: '8px', marginBottom: 0, paddingLeft: '20px' }}>
          <li>首次使用建议先在测试表格中试运行，熟悉功能后再正式使用</li>
          <li>如需恢复数据：进入「历史记录」→ 找到对应时间点记录 → 点击「还原此版本」</li>
          <li>重要数据建议额外手动备份一份</li>
        </ul>
      </footer>
    </div>
  );
}
