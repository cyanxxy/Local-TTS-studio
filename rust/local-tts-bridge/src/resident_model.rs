/// Reuse a matching resident model, or release it before loading a replacement.
/// Native runtimes such as llama.cpp allow only one live backend per process.
/// A failed replacement leaves the slot empty so the next request can retry.
pub fn ensure_resident_model<T, E>(
    resident: &mut Option<T>,
    matches: impl FnOnce(&T) -> bool,
    load: impl FnOnce() -> Result<T, E>,
) -> Result<(), E> {
    if resident.as_ref().is_some_and(matches) {
        return Ok(());
    }
    drop(resident.take());
    *resident = Some(load()?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    struct SingletonModel {
        name: &'static str,
        backend_live: Rc<Cell<bool>>,
    }

    impl SingletonModel {
        fn load(name: &'static str, backend_live: &Rc<Cell<bool>>) -> Result<Self, &'static str> {
            if backend_live.replace(true) {
                return Err("BackendAlreadyInitialized");
            }
            Ok(Self {
                name,
                backend_live: Rc::clone(backend_live),
            })
        }
    }

    impl Drop for SingletonModel {
        fn drop(&mut self) {
            self.backend_live.set(false);
        }
    }

    #[test]
    fn switching_models_releases_the_singleton_backend_before_loading() {
        let backend_live = Rc::new(Cell::new(false));
        let mut resident = Some(SingletonModel::load("nano", &backend_live).unwrap());

        ensure_resident_model(
            &mut resident,
            |model| model.name == "air",
            || SingletonModel::load("air", &backend_live),
        )
        .unwrap();

        assert_eq!(resident.as_ref().unwrap().name, "air");
        assert!(backend_live.get());
    }

    #[test]
    fn matching_requests_keep_the_existing_model() {
        let backend_live = Rc::new(Cell::new(false));
        let mut resident = Some(SingletonModel::load("nano", &backend_live).unwrap());

        let result: Result<(), &str> = ensure_resident_model(
            &mut resident,
            |model| model.name == "nano",
            || panic!("A matching model must not be loaded again"),
        );

        assert!(result.is_ok());
        assert!(backend_live.get());
    }

    #[test]
    fn a_failed_replacement_can_be_retried_without_a_live_backend() {
        let backend_live = Rc::new(Cell::new(false));
        let mut resident = Some(SingletonModel::load("nano", &backend_live).unwrap());
        assert_eq!(
            ensure_resident_model(&mut resident, |_| false, || Err("Model unavailable")),
            Err("Model unavailable")
        );
        assert!(resident.is_none());
        assert!(!backend_live.get());

        ensure_resident_model(
            &mut resident,
            |model| model.name == "air",
            || SingletonModel::load("air", &backend_live),
        )
        .unwrap();
        assert_eq!(resident.as_ref().unwrap().name, "air");
    }
}
