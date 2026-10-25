Component({
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '选择校区' },
    list: { type: Array, value: [] }
  },
  methods: {
    close() { this.triggerEvent('close'); },
    pick(event) { this.triggerEvent('select', { id: event.currentTarget.dataset.id }); },
    noop() {}
  }
});
