Component({
  properties: {
    order: { type: Object, value: null },
    mode: { type: String, value: 'student' },
    actionText: { type: String, value: '' }
  },
  methods: {
    onTap() { this.triggerEvent('open', { id: this.data.order.id }); },
    onAction() { this.triggerEvent('action', { id: this.data.order.id }); }
  }
});
